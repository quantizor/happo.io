import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Archiver from 'archiver';

import { FILE_CREATION_DATE } from './createStaticPackage';
import Logger, { logTag } from './Logger';
import constructReport from './constructReport';
import createHash from './createHash';
import ensureTarget from './ensureTarget';
import loadCSSFile from './loadCSSFile';
import uploadAssets from './uploadAssets';
import validateArchive from './validateArchive';

function staticDirToZipFile(dir) {
  return new Promise((resolve, reject) => {
    const archive = new Archiver('zip', {
      // Concurrency in the stat queue leads to non-deterministic output.
      // https://github.com/archiverjs/node-archiver/issues/383#issuecomment-2253139948
      statConcurrency: 1,
    });

    const rnd = crypto.randomBytes(4).toString('hex');
    const pathToZipFile = path.join(os.tmpdir(), `happo-static-${rnd}.zip`);
    const output = fs.createWriteStream(pathToZipFile);
    const entries = [];

    archive.on('entry', (entry) => {
      entries.push(entry);
    });

    output.on('close', async () => {
      validateArchive(archive.pointer(), entries);
      resolve(pathToZipFile);
    });
    archive.pipe(output);
    archive.directory(dir, false, { date: FILE_CREATION_DATE });
    archive.on('error', reject);
    archive.finalize();
  });
}

async function resolvePackageData(staticPackage) {
  if (typeof staticPackage === 'string') {
    // legacy plugins
    const buffer = Buffer.from(staticPackage, 'base64');
    return { value: buffer, hash: createHash(buffer) };
  }

  if (!staticPackage.path) {
    throw new Error(
      'Expected `staticPackage` to be an object with the following structure: `{ path: "path/to/folder" }`',
    );
  }

  const file = await staticDirToZipFile(staticPackage.path);

  const readStream = fs.createReadStream(file);
  const hash = await new Promise((resolve) => {
    const hashCreator = crypto.createHash('md5');
    readStream.pipe(hashCreator);
    hashCreator.setEncoding('hex');
    readStream.on('end', () => {
      hashCreator.end();
      resolve(hashCreator.read());
    });
  });
  readStream.destroy();
  return { value: fs.createReadStream(file), hash };
}

export default async function remoteRunner(
  { apiKey, apiSecret, endpoint, targets, plugins, stylesheets, project },
  { generateStaticPackage },
  { isAsync },
) {
  const logger = new Logger();

  try {
    logger.info(`${logTag(project)}Generating static package...`);
    const staticPackage = await generateStaticPackage();

    const { value, hash } = await resolvePackageData(staticPackage);
    const staticPackagePath = await uploadAssets(value, {
      hash,
      endpoint,
      apiSecret,
      apiKey,
      logger,
      project,
    });
    const targetNames = Object.keys(targets);
    const tl = targetNames.length;
    const cssBlocks = await Promise.all(stylesheets.map(loadCSSFile));
    plugins.forEach(({ css }) => cssBlocks.push(css || ''));
    logger.info(
      `${logTag(project)}Generating screenshots in ${tl} target${
        tl > 1 ? 's' : ''
      }...`,
    );
    const outerStartTime = Date.now();
    const results = await Promise.all(
      targetNames.map(async (name) => {
        const startTime = Date.now();
        const result = await ensureTarget(targets[name]).execute({
          targetName: name,
          asyncResults: isAsync,
          staticPackage: staticPackagePath,
          apiKey,
          apiSecret,
          endpoint,
          globalCSS: cssBlocks.join('').replace(/\n/g, ''),
        });
        logger.start(`  - ${logTag(project)}${name}`, { startTime });
        logger.success();
        return { name, result };
      }),
    );
    logger.start(undefined, { startTime: outerStartTime });
    logger.success();
    if (isAsync) {
      return results;
    }
    return constructReport(results);
  } catch (e) {
    logger.fail();
    throw e;
  }
}
