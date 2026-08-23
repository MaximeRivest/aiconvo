#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateTheme } = require('../themes.js');

function checkThemeFile(file) {
  const resolved = path.resolve(file);
  const id = path.basename(resolved, path.extname(resolved));
  const css = fs.readFileSync(resolved, 'utf8');
  return { id, file: resolved, ...validateTheme(css, id) };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.log('usage: node test/theme-check.js path/to/theme-id.css');
  } else {
    try {
      const result = checkThemeFile(file);
      if (!result.valid) {
        console.error(`invalid theme: ${result.file}`);
        for (const error of result.errors) console.error(`- ${error}`);
        process.exitCode = 1;
      } else {
        console.log(`valid theme: ${result.metadata.name} (${result.id})`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { checkThemeFile };
