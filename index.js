const readlineSync = require("readline-sync");
const fs = require('fs');
const pathUtil = require('path')
const TPK = require("./helper");

const path = readlineSync.question("Path to tpk:\n");
if (!path) {
  return console.log("Please input correct path");
}
if(pathUtil.extname(path) !== 'tpk' && !fs.existsSync(path)){
  return console.log("Please input correct file")
}

const tpk = new TPK(path);

tpk.saveTiles();
