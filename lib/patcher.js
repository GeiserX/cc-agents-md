'use strict';

const { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, unlinkSync } = require('fs');
const { dirname, join } = require('path');

/**
 * Regex to match Claude Code's async CLAUDE.md reader function.
 *
 * Matches the pattern (CC >= 2.1.83):
 *   async function NAME(A,B,C){try{let D=await FS().readFile(A,{encoding:"utf-8"});return PROC(D,A,B,C)}catch(E){return ERR(E,A),{info:null,includePaths:[]}}}
 *
 * Variable names are minified and change per build, so we capture them.
 */
const ASYNC_READER_RE = /async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/g;

/**
 * Sentinel comment injected into patched code to identify our changes.
 */
const PATCH_SENTINEL = '/*cc-agents-md-patch*/';

/**
 * Check if source code is already patched by cc-agents-md.
 */
function isPatched(source) {
  return source.includes(PATCH_SENTINEL);
}

/**
 * Generate the patched replacement for the async reader function.
 *
 * The patched version:
 * 1. Tries to read the file normally (CLAUDE.md)
 * 2. If the read fails AND the path ends with /CLAUDE.md or \CLAUDE.md,
 *    tries AGENTS.md in the same directory
 * 3. Also tries AGENTS.md alongside CLAUDE.local.md and .claude/CLAUDE.md
 * 4. Falls through to the original error handler if AGENTS.md also fails
 */
function buildReplacement(match, fnName, argPath, argType, argParam, varContent, fsAccessor, processor, catchVar, errorHandler) {
  // The replacement function with AGENTS.md fallback
  return `${PATCH_SENTINEL}async function ${fnName}(${argPath},${argType},${argParam},_ccamd_didReroute){try{let ${varContent}=await ${fsAccessor}().readFile(${argPath},{encoding:"utf-8"});return ${processor}(${varContent},${argPath},${argType},${argParam})}catch(${catchVar}){if(!_ccamd_didReroute){let _ccamd_alt=null;if(${argPath}.endsWith("/CLAUDE.md")||${argPath}.endsWith("\\\\CLAUDE.md"))_ccamd_alt=${argPath}.slice(0,-9)+"AGENTS.md";else if(${argPath}.endsWith("/CLAUDE.local.md")||${argPath}.endsWith("\\\\CLAUDE.local.md"))_ccamd_alt=${argPath}.slice(0,-15)+"AGENTS.local.md";else if(${argPath}.endsWith("/.claude/CLAUDE.md")||${argPath}.endsWith("\\\\.claude/CLAUDE.md"))_ccamd_alt=${argPath}.slice(0,-18)+"/.claude/AGENTS.md";if(_ccamd_alt)try{return await ${fnName}(_ccamd_alt,${argType},${argParam},true)}catch(_ccamd_e2){}}return ${errorHandler}(${catchVar},${argPath}),{info:null,includePaths:[]}}}`;
}

/**
 * Apply the AGENTS.md fallback patch to Claude Code source.
 *
 * @param {string} source - The cli.js source code
 * @returns {{ patched: string, matchCount: number }} - Patched source and number of matches
 */
function patchSource(source) {
  if (isPatched(source)) {
    return { patched: source, matchCount: -1 }; // Already patched
  }

  let matchCount = 0;
  const patched = source.replace(ASYNC_READER_RE, (...args) => {
    matchCount++;
    return buildReplacement(...args);
  });

  return { patched, matchCount };
}

/**
 * Remove the AGENTS.md fallback patch from Claude Code source.
 * Restores from backup if available, otherwise returns null.
 */
function unpatchSource(source) {
  if (!isPatched(source)) {
    return { unpatched: source, wasPatched: false };
  }

  // We can't reliably reverse the regex replacement on minified code,
  // so we rely on backup restoration at the caller level.
  return { unpatched: null, wasPatched: true };
}

/**
 * Backup file path for the original cli.js.
 */
function backupPath(cliJsPath) {
  return cliJsPath + '.cc-agents-md.bak';
}

/**
 * Patch an npm-installed Claude Code cli.js file.
 *
 * @param {string} cliJsPath - Absolute path to cli.js
 * @param {object} options - { dryRun: boolean }
 * @returns {{ success: boolean, message: string, matchCount: number }}
 */
function patchNpm(cliJsPath, options = {}) {
  if (!existsSync(cliJsPath)) {
    return { success: false, message: `File not found: ${cliJsPath}`, matchCount: 0 };
  }

  const source = readFileSync(cliJsPath, 'utf8');

  if (isPatched(source)) {
    return { success: false, message: 'Already patched by cc-agents-md.', matchCount: -1 };
  }

  const { patched, matchCount } = patchSource(source);

  if (matchCount === 0) {
    return {
      success: false,
      message: 'Could not find the CLAUDE.md reader function. This Claude Code version may not be compatible.',
      matchCount: 0,
    };
  }

  if (options.dryRun) {
    return { success: true, message: `Dry run: would patch ${matchCount} location(s).`, matchCount };
  }

  // Create backup
  const backup = backupPath(cliJsPath);
  copyFileSync(cliJsPath, backup);

  // Write patched version
  writeFileSync(cliJsPath, patched);

  return {
    success: true,
    message: `Patched ${matchCount} location(s). Backup saved to ${backup}`,
    matchCount,
  };
}

/**
 * Unpatch an npm-installed Claude Code cli.js by restoring from backup.
 *
 * @param {string} cliJsPath - Absolute path to cli.js
 * @returns {{ success: boolean, message: string }}
 */
function unpatchNpm(cliJsPath) {
  const backup = backupPath(cliJsPath);

  if (existsSync(backup)) {
    copyFileSync(backup, cliJsPath);
    unlinkSync(backup);
    return { success: true, message: 'Restored original from backup.' };
  }

  // No backup — try to detect and warn
  if (existsSync(cliJsPath)) {
    const source = readFileSync(cliJsPath, 'utf8');
    if (!isPatched(source)) {
      return { success: true, message: 'Not patched — nothing to do.' };
    }
    return {
      success: false,
      message: 'Patched but no backup found. Reinstall Claude Code to restore: npm install -g @anthropic-ai/claude-code',
    };
  }

  return { success: false, message: `File not found: ${cliJsPath}` };
}

module.exports = {
  ASYNC_READER_RE,
  PATCH_SENTINEL,
  isPatched,
  patchSource,
  unpatchSource,
  patchNpm,
  unpatchNpm,
  backupPath,
};
