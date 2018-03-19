// @flow

import type Config from '../config.js';
import type PackageResolver from '../package-resolver.js';
import pnpApi from './generate-pnp-map-api.tpl.js';
import * as fs from './fs.js';

const crypto = require('crypto');
const invariant = require('invariant');
const path = require('path');

type PackageInformation = {|
  packageLocation: string,
  packageMainEntry: ?string,
  packageDependencies: Map<string, string>,
|};
type PackageInformationStore = Map<string | null, PackageInformation>;
type PackageInformationStores = Map<string | null, PackageInformationStore>;

function generateMaps(packageInformationStores: PackageInformationStores): string {
  let code = ``;

  // Bake the information stores into our generated code
  code += `let packageInformationStores = new Map([\n`;
  for (const [packageName, packageInformationStore] of packageInformationStores) {
    code += `  [${JSON.stringify(packageName)}, new Map([\n`;
    for (const [
      packageReference,
      {packageMainEntry, packageLocation, packageDependencies},
    ] of packageInformationStore) {
      code += `    [${JSON.stringify(packageReference)}, {\n`;
      code += `      packageLocation: ${JSON.stringify(packageLocation)},\n`;
      if (packageMainEntry) {
        code += `      packageMainEntry: ${JSON.stringify(packageMainEntry)},\n`;
      }
      code += `      packageDependencies: new Map([\n`;
      for (const [dependencyName, dependencyReference] of packageDependencies.entries()) {
        code += `        [${JSON.stringify(dependencyName)}, ${JSON.stringify(dependencyReference)}],\n`;
      }
      code += `      ]),\n`;
      code += `    }],\n`;
    }
    code += `  ])],\n`;
  }
  code += `]);\n`;

  code += `\n`;

  // Also bake an inverse map that will allow us to find the package information based on the path
  code += `let locatorsByLocations = new Map([\n`;
  for (const [packageName, packageInformationStore] of packageInformationStores) {
    for (const [packageReference, {packageLocation}] of packageInformationStore) {
      if (packageName !== null) {
        code += `  [${JSON.stringify(packageLocation)}, ${JSON.stringify({
          name: packageName,
          reference: packageReference,
        })}],\n`;
      } else {
        code += `  [${JSON.stringify(packageLocation)}, topLevelLocator],\n`;
      }
    }
  }
  code += `]);\n`;

  return code;
}

function generateFindPackageLocator(packageInformationStores: PackageInformationStores): string {
  let code = ``;

  // We get the list of each string length we'll need to check in order to find the current package context
  const lengths = new Map();

  for (const packageInformationStore of packageInformationStores.values()) {
    for (const {packageLocation} of packageInformationStore.values()) {
      if (packageLocation !== null) {
        lengths.set(packageLocation.length, (lengths.get(packageLocation.length) || 0) + 1);
      }
    }
  }

  // We sort the lengths by the number of time they are used, so that the more common ones are tested before the others
  const sortedLengths = Array.from(lengths.entries()).sort((a, b) => {
    return b[1] - a[1];
  });

  // Generate a function that, given a file path, returns the associated package name
  code += `exports.findPackageLocator = function findPackageLocator(location) {\n`;
  code += `  let match;\n`;

  for (const [length] of sortedLengths) {
    code += `\n`;
    code += `  if (location.length >= ${length} && location[${length} - 1] === path.sep)\n`;
    code += `    if (match = locatorsByLocations.get(location.substr(0, ${length})))\n`;
    code += `      return match;\n`;
  }

  code += `\n`;
  code += `  return null;\n`;
  code += `};\n`;

  return code;
}

async function getPackageInformationStores(
  config: Config,
  seedPatterns: Array<string>,
  {resolver}: {resolver: PackageResolver},
): Promise<PackageInformationStores> {
  const packageInformationStores: PackageInformationStores = new Map();

  const getHashFrom = (data: Array<string>) => {
    const hashGenerator = crypto.createHash('sha1');

    for (const datum of data) {
      hashGenerator.update(datum);
    }

    return hashGenerator.digest('hex');
  };

  const getResolverEntry = pattern => {
    const pkg = resolver.getStrictResolvedPattern(pattern);
    const ref = pkg._reference;

    if (!ref) {
      return null;
    }

    const loc = ref.location;

    if (!loc) {
      return null;
    }

    return {pkg, ref, loc};
  };

  const visit = async (
    seedPatterns: Array<string>,
    parentData: Array<string> = [],
    availablePackages: Map<string, string> = new Map(),
  ) => {
    const resolutions = new Map();
    const locations = new Map();

    // This first pass will compute the package reference of each of the given patterns
    // They will usually be the package version, but not always. We need to do this in a pre-process pass, because the
    // dependencies might depend on one another, so if we need to replace one of them, we need to compute it first
    for (const pattern of seedPatterns) {
      const entry = getResolverEntry(pattern);

      if (!entry) {
        continue;
      }

      const {pkg} = entry;
      let {loc} = entry;

      const packageName = pkg.name;
      let packageReference = pkg.version;

      // If we have peer dependencies, then we generate a new virtual reference based on the parent one
      // We cannot generate this reference based on what those peer references resolve to, because they might not have
      // been computed yet (for example, consider the case where A has a peer dependency on B, and B a peer dependency
      // on A; it's valid, but it prevents us from computing A and B - and it's even worse with 3+ packages involved)
      const peerDependencies = new Set(Array.from(Object.keys(pkg.peerDependencies || {})));

      if (peerDependencies.size > 0) {
        const hash = getHashFrom([...parentData, packageName, packageReference]);

        const newLoc = path.resolve(path.dirname(loc), `pnp-${hash}`);
        await fs.symlink(loc, newLoc);
        loc = newLoc;

        packageReference = `pnp:${hash}`;
      }

      // Now that we have the final reference, we need to store it
      resolutions.set(packageName, packageReference);
      locations.set(packageName, loc);
    }

    // Now that we have the final references, we can start the main loop, which will insert the packages into the store
    // if they aren't already there, and recurse over their own children
    for (const pattern of seedPatterns) {
      const entry = getResolverEntry(pattern);

      if (!entry) {
        continue;
      }

      const {pkg, ref} = entry;

      const packageName = pkg.name;

      const packageReference = resolutions.get(packageName);
      invariant(packageReference, `Package reference should have been computed during the pre-pass`);

      const loc = locations.get(packageName);
      invariant(loc, `Package location should have been computed during the pre-pass`);

      // We can early exit if the package is already registered with the exact same name and reference, since even if
      // we might get slightly different dependencies (depending on how things were optimized), both sets are valid
      let packageInformationStore = packageInformationStores.get(packageName);

      if (!packageInformationStore) {
        packageInformationStore = new Map();
        packageInformationStores.set(packageName, packageInformationStore);
      }

      let packageInformation = packageInformationStore.get(packageReference);

      if (packageInformation) {
        continue;
      }

      packageInformation = {
        packageMainEntry: pkg.main,
        packageLocation: loc.replace(/[\\\/]?$/, path.sep),
        packageDependencies: new Map(),
      };

      // Split the dependencies between direct/peer - we will only recurse on the former
      const peerDependencies = new Set(Array.from(Object.keys(pkg.peerDependencies || {})));
      const directDependencies = ref.dependencies.filter(pattern => {
        const pkg = resolver.getStrictResolvedPattern(pattern);
        return !pkg || !peerDependencies.has(pkg.name);
      });

      // We do this in two steps to prevent cyclic dependencies from looping indefinitely
      packageInformationStore.set(packageReference, packageInformation);
      packageInformation.packageDependencies = await visit(directDependencies, [packageName, packageReference]);

      // We now have to inject the peer dependencies
      for (const dependencyName of peerDependencies) {
        const dependencyReference = resolutions.get(dependencyName);

        if (dependencyReference) {
          packageInformation.packageDependencies.set(dependencyName, dependencyReference);
        }
      }
    }

    return resolutions;
  };

  packageInformationStores.set(
    null,
    new Map([
      [
        null,
        {
          packageMainEntry: null,
          packageLocation: (await fs.realpath(config.lockfileFolder)).replace(/[\\\/]?$/, path.sep),
          packageDependencies: await visit(seedPatterns),
        },
      ],
    ]),
  );

  return packageInformationStores;
}

export async function generatePnpMap(
  config: Config,
  seedPatterns: Array<string>,
  {resolver}: {resolver: PackageResolver},
): Promise<string> {
  const packageInformationStores = await getPackageInformationStores(config, seedPatterns, {resolver});
  const setupStaticTables =
    generateMaps(packageInformationStores) + generateFindPackageLocator(packageInformationStores);

  return pnpApi.replace(/\$\$SETUP_STATIC_TABLES\(\);/, setupStaticTables);
}
