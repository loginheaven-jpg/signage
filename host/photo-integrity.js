'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
async function fileIntegrity(file) {
  const sha256 = createHash('sha256'), md5 = createHash('md5');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; sha256.update(chunk); md5.update(chunk); }
  return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}
module.exports = { fileIntegrity };
