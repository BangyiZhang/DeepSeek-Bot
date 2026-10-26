import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

// Bundle operations must treat app.asar as a sealed file, not Electron's virtual directory.
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs
export const { createReadStream, constants } = fs
export const { chmod, cp, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, writeFile } = fs.promises
