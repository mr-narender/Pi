#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';

function parseArgs(argv) {
  const options = {
    coverageFile: 'docs/RPC_COVERAGE.md',
    evidenceFile: 'docs/RPC_COVERAGE_EVIDENCE.json',
    sourceRoot: 'src',
    testRoot: 'test',
  };
  for (const arg of argv) {
    if (arg.startsWith('--coverage=')) {
      options.coverageFile = arg.slice('--coverage='.length);
    } else if (arg.startsWith('--evidence=')) {
      options.evidenceFile = arg.slice('--evidence='.length);
    } else if (arg.startsWith('--source-root=')) {
      options.sourceRoot = arg.slice('--source-root='.length);
    } else if (arg.startsWith('--test-root=')) {
      options.testRoot = arg.slice('--test-root='.length);
    }
  }
  return options;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else {
      files.push(path.replace(/\\/g, '/'));
    }
  }
  return files;
}

function scriptKindFor(file) {
  switch (extname(file)) {
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
      return ts.ScriptKind.JS;
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.mjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function createSourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
}

function hasExportModifier(node) {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    : false;
}

function memberName(name) {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function collectExportedSymbols(file, text) {
  const sourceFile = createSourceFile(file, text);
  const symbols = new Set();

  function addClassMembers(className, node) {
    for (const member of node.members) {
      if (
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        const name = memberName(member.name);
        if (name) {
          symbols.add(`${className}.${name}`);
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      symbols.add(statement.name.text);
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      symbols.add(statement.name.text);
      addClassMembers(statement.name.text, statement);
      continue;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          symbols.add(declaration.name.text);
        }
      }
    }
  }

  return symbols;
}

function calleeRootName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return calleeRootName(expression.expression);
  }
  return undefined;
}

function literalText(node) {
  if (!node) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function collectTestTitles(file, text) {
  const sourceFile = createSourceFile(file, text);
  const titles = new Set();

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = calleeRootName(node.expression);
      if (callee === 'test' || callee === 'it') {
        const title = literalText(node.arguments[0]);
        if (title) {
          titles.add(title);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return titles;
}

function fail(errors, output) {
  console.error(JSON.stringify({ ok: false, errors, output }, null, 2));
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
for (const path of [options.coverageFile, options.evidenceFile]) {
  if (!existsSync(path)) {
    fail([`missing required file ${path}`], []);
  }
}

const coverage = readFileSync(options.coverageFile, 'utf8');
const evidence = JSON.parse(readFileSync(options.evidenceFile, 'utf8'));
if (!Array.isArray(evidence)) {
  fail([`evidence file must contain a JSON array: ${options.evidenceFile}`], []);
}

const sourceFiles = walk(options.sourceRoot).filter((file) => file.endsWith('.ts'));
const testFiles = walk(options.testRoot).filter(
  (file) => file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.cjs')
);
const sourceSymbolIndex = new Map(
  sourceFiles.map((file) => [file, collectExportedSymbols(file, readFileSync(file, 'utf8'))])
);
const testTitleIndex = new Map(
  testFiles.map((file) => [file, collectTestTitles(file, readFileSync(file, 'utf8'))])
);

const expectedRows = [...coverage.matchAll(/\|\s((?:C|E|U|X|D)-\d{3})\s\|/g)].map(
  (match) => match[1]
);
const expectedIds = new Set(expectedRows);
const seenIds = new Set();
const usedTests = new Map();
const errors = [];
const output = [];

for (const id of expectedRows) {
  if (seenIds.has(id)) {
    errors.push(`duplicate coverage row id ${id}`);
    continue;
  }
  seenIds.add(id);

  const row = evidence.find((item) => item && item.id === id);
  if (!row || typeof row !== 'object') {
    errors.push(`missing evidence row ${id}`);
    continue;
  }

  const sourceFile = typeof row.sourceFile === 'string' ? row.sourceFile.replace(/^\.\//, '') : '';
  const symbol = typeof row.symbol === 'string' ? row.symbol : '';
  const testFile = typeof row.testFile === 'string' ? row.testFile.replace(/^\.\//, '') : '';
  const testTitle = typeof row.testTitle === 'string' ? row.testTitle : '';
  const justification = typeof row.justification === 'string' ? row.justification.trim() : '';

  if (!sourceFile) {
    errors.push(`missing sourceFile for ${id}`);
  } else if (!sourceSymbolIndex.has(sourceFile)) {
    errors.push(`unknown source file for ${id}: ${sourceFile}`);
  }

  if (!symbol) {
    errors.push(`missing symbol for ${id}`);
  } else if (!sourceFile || !sourceSymbolIndex.get(sourceFile)?.has(symbol)) {
    errors.push(`missing symbol ${symbol} in ${sourceFile || '<unknown source file>'} for ${id}`);
  }

  if (!testFile) {
    errors.push(`missing testFile for ${id}`);
  } else if (!testTitleIndex.has(testFile)) {
    errors.push(`unknown test file for ${id}: ${testFile}`);
  }

  if (!testTitle) {
    errors.push(`missing testTitle for ${id}`);
  } else if (!testFile || !testTitleIndex.get(testFile)?.has(testTitle)) {
    errors.push(
      `missing literal test title ${testTitle} in ${testFile || '<unknown test file>'} for ${id}`
    );
  }

  const testKey = `${testFile}::${testTitle}`;
  const prior = usedTests.get(testKey);
  if (prior) {
    if (!justification) {
      errors.push(`duplicate evidence reuse for ${id} and ${prior.id}: ${testKey}`);
    }
  } else {
    usedTests.set(testKey, { id, justification });
  }

  output.push({
    id,
    surface: typeof row.surface === 'string' ? row.surface : null,
    symbol,
    sourceFile: sourceFile || null,
    testFile: testFile || null,
    testTitle,
  });
}

for (const row of evidence) {
  if (!row || typeof row !== 'object') {
    errors.push('evidence rows must be objects');
    continue;
  }
  if (!expectedIds.has(row.id)) {
    errors.push(`orphan evidence row ${String(row.id)}`);
  }
}

if (errors.length > 0) {
  fail(errors, output);
}

console.log(JSON.stringify({ ok: true, output }, null, 2));
