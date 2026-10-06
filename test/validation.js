'use strict'

// Dependency-free regression tests. Each case gets a fresh process and package
// fixture; package-json and pkg-up are replaced before loading the real entry.
const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

function runChild (root, fixture, config) {
  const Module = require('module')
  const load = Module._load
  const report = { calls: [], unhandled: [], networkAttempts: 0 }
  const registryError = new Error('Fixture registry failure')

  require('net').Socket.prototype.connect = function () {
    report.networkAttempts++
    throw new Error('Unexpected network access in validation test')
  }

  process.on('unhandledRejection', (error) => {
    report.unhandled.push(error.message)
  })
  process.on('exit', () => {
    fs.writeFileSync(path.join(fixture, 'report.json'), JSON.stringify(report))
  })

  Module._load = function (request, parent, isMain) {
    if (request === 'pkg-up') {
      return { sync: () => config.noPackage ? null : path.join(fixture, 'package.json') }
    }
    if (request === 'package-json') {
      return (name) => {
        report.calls.push(name)
        if (config.registryError) return Promise.reject(registryError)
        return Promise.resolve({ name, version: '9.8.7', description: 'Fixture metadata' })
      }
    }
    return load.call(this, request, parent, isMain)
  }

  process.chdir(fixture)
  if (config.cli) {
    const cli = path.join(root, 'cli.js')
    process.argv = [process.execPath, cli].concat(config.args)
    require(cli)
    return
  }

  try {
    const check = require(root)
    const result = check.apply(null, config.args)
    report.returnsPromise = result instanceof Promise
    result.then((value) => {
      report.outcome = 'fulfilled'
      report.value = value
    }, (error) => {
      report.outcome = 'rejected'
      report.error = { name: error.name, message: error.message }
      report.sameRegistryError = error === registryError
    })
  } catch (error) {
    report.outcome = 'threw'
    report.error = { name: error.name, message: error.message }
  }
}

function runTests (root) {
  const packageFixture = {
    devDependencies: { dev: '^1.0.0' },
    dependencies: { prod: '~2.0.0' },
    peerDependencies: { peer: '3.x' },
    bundledDependencies: { bundled: '4.0.0' },
    optionalDependencies: { optional: '*' }
  }
  const cases = []
  const missing = (name) => name + ' is not listed as a dependency in your package.json'
  const expectedResult = (name) => ({
    currentVersion: packageFixture.devDependencies[name] || packageFixture.dependencies[name] ||
      packageFixture.peerDependencies[name] || packageFixture.bundledDependencies[name] ||
      packageFixture.optionalDependencies[name],
    newVersion: '9.8.7',
    name,
    description: 'Fixture metadata'
  })

  function add (name, config, verify) {
    cases.push({ name, config, verify })
  }

  function rejects (message) {
    return (report) => {
      assert.strictEqual(report.returnsPromise, true, 'must return a promise')
      assert.strictEqual(report.outcome, 'rejected', 'caller must receive a rejection')
      assert.deepEqual(report.error, { name: 'Error', message })
      assert.deepEqual(report.calls, [], 'validation must finish before registry requests')
    }
  }

  function resolves (names) {
    return (report) => {
      assert.strictEqual(report.returnsPromise, true)
      assert.strictEqual(report.outcome, 'fulfilled')
      assert.deepEqual(report.calls, names)
      assert.deepEqual(report.value, names.map(expectedResult))
    }
  }

  add('invalid dependency rejects', { args: ['missing'] }, rejects(missing('missing')))
  add('valid then invalid makes no requests', { args: ['prod', 'missing'] }, rejects(missing('missing')))
  add('invalid then valid makes no requests', { args: ['missing', 'prod'] }, rejects(missing('missing')))
  add('multiple invalid dependencies report the first', { args: ['prod', 'missing', 'other'] }, rejects(missing('missing')))
  add('validation wins over registry failure', { args: ['prod', 'missing'], registryError: true }, rejects(missing('missing')))
  add('missing package file rejects', { args: ['prod'], noPackage: true }, rejects('No package.json found.'))
  add('empty arguments resolve without requests', { args: [] }, resolves([]))
  add('one valid dependency preserves metadata', { args: ['prod'] }, resolves(['prod']))
  const allTypes = ['optional', 'peer', 'dev', 'prod', 'bundled']
  add('all existing dependency types preserve argument order', { args: allTypes }, resolves(allTypes))
  add('duplicate arguments preserve existing results', { args: ['prod', 'prod'] }, resolves(['prod', 'prod']))
  add('registry rejection reaches the caller', { args: ['prod'], registryError: true }, (report) => {
    assert.strictEqual(report.returnsPromise, true)
    assert.strictEqual(report.outcome, 'rejected')
    assert.strictEqual(report.sameRegistryError, true)
    assert.deepEqual(report.calls, ['prod'])
  })

  function cliError (message, calls) {
    return (report, output) => {
      assert.deepEqual(report.calls, calls)
      assert.notStrictEqual(output.indexOf('Error: ' + message), -1)
      assert.strictEqual(output.indexOf('Fixture metadata'), -1)
    }
  }

  add('CLI catches invalid dependency', { cli: true, args: ['missing'] }, cliError(missing('missing'), []))
  add('CLI catches mixed arguments before any requests', { cli: true, args: ['prod', 'missing'] }, cliError(missing('missing'), []))
  add('CLI catches missing package file', { cli: true, args: ['prod'], noPackage: true }, cliError('No package.json found.', []))
  add('CLI catches registry rejection', { cli: true, args: ['prod'], registryError: true }, cliError('Fixture registry failure', ['prod']))
  add('CLI prints valid results', { cli: true, args: ['prod'] }, (report, output) => {
    assert.deepEqual(report.calls, ['prod'])
    ;['currentVersion', '~2.0.0', 'newVersion', '9.8.7', 'prod', 'Fixture metadata'].forEach((value) => {
      assert.notStrictEqual(output.indexOf(value), -1)
    })
    assert.strictEqual(output.indexOf('Error:'), -1)
  })
  add('CLI prints empty result without requests', { cli: true, args: [] }, (report, output) => {
    assert.deepEqual(report.calls, [])
    assert.strictEqual(output.trim(), '[]')
  })

  let failed = 0
  cases.forEach((item, index) => {
    const fixture = path.join(os.tmpdir(), 'check-if-outdated-' + process.pid + '-' + Date.now() + '-' + index)
    fs.mkdirSync(fixture)
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(packageFixture))
    try {
      const child = childProcess.spawnSync(process.execPath, [__filename, '--child', root, fixture, JSON.stringify(item.config)], {
        encoding: 'utf8', timeout: 5000
      })
      assert.ifError(child.error)
      assert.strictEqual(child.signal, null)
      assert.strictEqual(child.status, 0, child.stderr)
      assert.strictEqual(child.stderr, '')
      const report = JSON.parse(fs.readFileSync(path.join(fixture, 'report.json'), 'utf8'))
      assert.strictEqual(report.networkAttempts, 0, 'no network is allowed')
      assert.deepEqual(report.unhandled, [], 'must not create unhandled rejections')
      item.verify(report, child.stdout)
      console.log('PASS ' + item.name)
    } catch (error) {
      failed++
      console.error('FAIL ' + item.name + ': ' + error.message)
    } finally {
      fs.readdirSync(fixture).forEach((file) => fs.unlinkSync(path.join(fixture, file)))
      fs.rmdirSync(fixture)
    }
  })
  console.log((cases.length - failed) + '/' + cases.length + ' validation cases passed on ' + process.version)
  if (failed) process.exitCode = 1
}

if (process.argv[2] === '--child') {
  runChild(process.argv[3], process.argv[4], JSON.parse(process.argv[5]))
} else {
  runTests(path.resolve(process.argv[2] || path.join(__dirname, '..')))
}
