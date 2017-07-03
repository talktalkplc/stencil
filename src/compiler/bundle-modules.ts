import { BundlerConfig, Bundle, ComponentMeta, Manifest, ModuleResults, Logger, StencilSystem, WorkerBuildContext } from './interfaces';
import { BUNDLES_DIR } from '../util/constants';
import { formatDefineComponents, formatJsBundleFileName, generateBundleId } from '../util/data-serialize';
import { writeFile } from './util';
import { WorkerManager } from './worker-manager';


export function bundleModules(logger: Logger, bundlerConfig: BundlerConfig, workerManager: WorkerManager, userManifest: Manifest) {
  logger.debug(`bundleModules`);

  const moduleResults: ModuleResults = {
    bundles: {},
    diagnostics: []
  };

  return Promise.all(userManifest.bundles.map(userBundle => {
    return generateDefineComponents(bundlerConfig, workerManager, userManifest, userBundle, moduleResults);
  })).then(() => {
    return moduleResults;
  });
}


function generateDefineComponents(bundlerConfig: BundlerConfig, workerManager: WorkerManager, userManifest: Manifest, userBundle: Bundle, moduleResults: ModuleResults) {
  const bundleComponentMeta = userBundle.components.map(userBundleComponentTag => {
    const cmpMeta = userManifest.components.find(c => c.tagNameMeta === userBundleComponentTag);
    if (!cmpMeta) {
      moduleResults.diagnostics.push({
        msg: `Unable to find component "${cmpMeta.tagNameMeta}" in available config and collection`,
        level: 'error'
      });
    }
    return cmpMeta;
  }).filter(c => !!c);

  return workerManager.generateDefineComponents(bundlerConfig, bundleComponentMeta).then(bundleModuleResults => {
    if (bundleModuleResults.bundles) {
      Object.assign(moduleResults.bundles, bundleModuleResults.bundles);
    }

    if (bundleModuleResults.diagnostics) {
      moduleResults.diagnostics = moduleResults.diagnostics.concat(bundleModuleResults.diagnostics);
    }
  });
}


export function generateDefineComponentsWorker(sys: StencilSystem, ctx: WorkerBuildContext, bundlerConfig: BundlerConfig, bundleComponentMeta: ComponentMeta[], userBundle: Bundle) {
  const moduleResults: ModuleResults = {
    bundles: {}
  };

  // loop through each bundle the user wants and create the "defineComponents"
  return bundleComponentModules(sys, ctx, bundleComponentMeta, moduleResults).then(jsModuleContent => {

    const bundleId = generateBundleId(userBundle.components);

    // format all the JS bundle content
    // insert the already bundled JS module into the defineComponents function
    let moduleContent = formatDefineComponents(
      bundlerConfig.namespace, STENCIL_BUNDLE_ID,
      jsModuleContent, bundleComponentMeta
    );

    if (bundlerConfig.isDevMode) {
      // dev mode has filename from the bundled tag names
      moduleResults.bundles[bundleId] = userBundle.components.sort().join('.').toLowerCase();

      if (moduleResults.bundles[bundleId].length > 40) {
        // can get a lil too long, so let's simmer down
        moduleResults.bundles[bundleId] = moduleResults.bundles[bundleId].substr(0, 40);
      }

    } else {
      // minify the JS content in prod mode
      const minifyResults = sys.uglify.minify(moduleContent);

      if (minifyResults.error) {
        moduleResults.diagnostics = moduleResults.diagnostics || [];
        moduleResults.diagnostics.push({
          msg: minifyResults.error.message,
          level: 'error'
        });

      } else {
        moduleContent = minifyResults.code;
      }

      // in prod mode, create bundle id from hashing the content
      moduleResults.bundles[bundleId] = sys.generateContentHash(moduleContent);
    }

    // replace the known bundle id template with the newly created bundle id
    moduleContent = moduleContent.replace(MODULE_ID_REGEX, moduleResults.bundles[bundleId]);

    // create the file name and path of where the bundle will be saved
    const moduleFileName = formatJsBundleFileName(moduleResults.bundles[bundleId]);
    const moduleFilePath = sys.path.join(bundlerConfig.destDir, BUNDLES_DIR, bundlerConfig.namespace.toLowerCase(), moduleFileName);

    return writeFile(sys, moduleFilePath, moduleContent).then(() => {
      return moduleResults;

    }).catch(err => {
      // writeFile error
      moduleResults.diagnostics = moduleResults.diagnostics || [];
      moduleResults.diagnostics.push({
        msg: err.toString(),
        level: 'error'
      });
      return moduleResults;
    });

  }).catch(err => {
    // bundleComponentModules error
    moduleResults.diagnostics = moduleResults.diagnostics || [];
    moduleResults.diagnostics.push({
      msg: err.toString(),
      level: 'error'
    });
    return moduleResults;
  });
}


function bundleComponentModules(sys: StencilSystem, ctx: WorkerBuildContext, bundleComponentMeta: ComponentMeta[], moduleResults: ModuleResults) {
  const entryFileLines: string[] = [];

  // loop through all the components this bundle needs
  // and generate a string of the JS file to be generated
  bundleComponentMeta.sort((a, b) => {
    if (a.tagNameMeta.toLowerCase() < b.tagNameMeta.toLowerCase()) return -1;
    if (a.tagNameMeta.toLowerCase() > b.tagNameMeta.toLowerCase()) return 1;
    return 0;

  }).forEach(cmpMeta => {
    // create a full path to the modules to import
    let importPath = cmpMeta.componentUrl;

    // manually create the content for our temporary entry file for the bundler
    entryFileLines.push(`import { ${cmpMeta.componentClass} } from "${importPath}";`);

    // export map should always use UPPER CASE tag name
    entryFileLines.push(`exports['${cmpMeta.tagNameMeta.toUpperCase()}'] = ${cmpMeta.componentClass};`);
  });

  // create the entry file for the bundler
  const entryContent = entryFileLines.join('\n');

  // start the bundler on our temporary file
  return sys.rollup.rollup({
    entry: STENCIL_BUNDLE_ID,
    plugins: [
      sys.rollup.plugins.nodeResolve({
        jsnext: true,
        main: true
      }),
      sys.rollup.plugins.commonjs({
        include: 'node_modules/**',
        sourceMap: false
      }),
      entryInMemoryPlugin(STENCIL_BUNDLE_ID, entryContent),
      transpiledInMemoryPlugin(ctx)
    ],
    onwarn: createOnWarnFn(moduleResults)

  }).catch(err => {
    throw err;
  })

  .then(rollupBundle => {
    // generate the bundler results
    const results = rollupBundle.generate({
      format: 'es'
    });

    // module bundling finished, assign its content to the user's bundle
    return `function importComponent(exports, h, t, Ionic) {\n${results.code.trim()}\n}`;
  });
}


function createOnWarnFn(moduleResults: ModuleResults) {
  const previousWarns: {[key: string]: boolean} = {};

  return function onWarningMessage(warning: any) {
    if (warning && warning.message in previousWarns) {
      return;
    }
    previousWarns[warning.message] = true;

    moduleResults.diagnostics = moduleResults.diagnostics || [];
    moduleResults.diagnostics.push({
      msg: warning,
      level: 'warn'
    });
  };
}


function transpiledInMemoryPlugin(ctx: WorkerBuildContext) {
  return {
    name: 'transpiledInMemoryPlugin',
    resolveId(importee: string): string {
      let fileMeta = ctx.moduleFiles.get(importee);
      if (fileMeta && fileMeta.jsText) {
        return importee;
      }

      var mapIter = ctx.moduleFiles.values();
      while (fileMeta = mapIter.next().value) {
        if (fileMeta.jsFilePath === importee && fileMeta.jsText) {
          return importee;
        }
      }
      return null;
    },
    load(sourcePath: string): string {
      let fileMeta = ctx.moduleFiles.get(sourcePath);
      if (fileMeta && fileMeta.jsText) {
        return fileMeta.jsText;
      }

      var mapIter = ctx.moduleFiles.values();
      while (fileMeta = mapIter.next().value) {
        if (fileMeta.jsFilePath === sourcePath && fileMeta.jsText) {
          return fileMeta.jsText;
        }
      }

      return null;
    }
  };
}


function entryInMemoryPlugin(entryKey: string, entryFileContent: string) {
  // used just so we don't have to write a temporary file to disk
  // just to turn around and immediately have rollup open and read it
  return {
    name: 'entryInMemoryPlugin',
    resolveId(importee: string): string {
      if (importee === entryKey) {
        return entryKey;
      }
      return null;
    },
    load(sourcePath: string): string {
      if (sourcePath === entryKey) {
        return entryFileContent;
      }
      return null;
    }
  };
}


const STENCIL_BUNDLE_ID = '__STENCIL__BUNDLE__ID__';
const MODULE_ID_REGEX = new RegExp(STENCIL_BUNDLE_ID, 'g');
