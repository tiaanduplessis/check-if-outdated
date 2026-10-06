'use strict'

const packageJson = require('package-json')
const pkgUp = require('pkg-up')

function dependencyInfo (pkgJson) {
  const dependencies = {}
  const types = ['devDependencies', 'dependencies', 'peerDependencies', 'bundledDependencies', 'optionalDependencies']

  types.forEach((type) => {
    if (pkgJson[type]) {
      for (let dependency in pkgJson[type]) {
        dependencies[dependency] = pkgJson[type][dependency]
      }
    }
  })

  return dependencies
}

module.exports = function (...dependencies) {
  const filePath = pkgUp.sync()

  if (!filePath) {
    return Promise.reject(new Error('No package.json found.'))
  }

  const pkg = require(filePath)
  const pkgDependencies = dependencyInfo(pkg)

  for (let i = 0; i < dependencies.length; i++) {
    const dependency = dependencies[i]
    if (!pkgDependencies[dependency]) {
      return Promise.reject(new Error(`${dependency} is not listed as a dependency in your package.json`))
    }
  }

  return Promise.all(
    dependencies.map((dependency) => packageJson(dependency))
  ).then((results) => {
    return results.map((info) => {
      const currentVersion = pkgDependencies[info.name]
      const newVersion = info.version
      delete info.version

      return Object.assign({
        currentVersion,
        newVersion
      }, info)
    })
  })
}
