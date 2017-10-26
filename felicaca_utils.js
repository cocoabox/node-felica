#!/usr/bin/env node

'use strict'

/**
 * @param {number} n
 * @return {number[]}
 */
function range(n) {
    return Array.from({length: n}, (value, key) => key)
}

/**
 * serially executes a list of Promises; exit on first failure; shamelessly ripped from :
 * @link https://hackernoon.com/functional-javascript-resolving-promises-sequentially-7aac18c4431e
 *
 * @param {function[]} funcs  An array of functions; each should return a promise
 *      i.e. [()=>new Promise(ok, ng){..}, ()=>new Promise(ok, ng){..}, ...]
 * @return {Promise}
 *      if successful, resolves with [RESULT1, RESULT2, ...]
 *      if failure, rejects with ERRORn (first error encountered)
 */
function serial(funcs) {
    return funcs.reduce((promise, func) =>
        promise.then(result =>
            func().then(Array.prototype.concat.bind(result))), Promise.resolve([])
    )
}

/**
 * reads N bytes from a binary buffer and convert into a number (either large or small endian)
 * @param {Buffer} buffer
 * @param {number} idx
 *      starting index to read
 * @param {number} [len]
 *      if omitted, then read until the end of the buffer
 * @param {string} byte_order endianess; should be 'LE' or 'BE'
 * @returns {number}
 */
function read_number(buffer, idx, len = 0, byte_order = 'LE') {
    if (!(buffer instanceof Buffer))
        throw `expecting instance of Buffer ; received : ${buffer}`;
    var extracted_data = [],
        end_idx = len ? idx + len : buffer.length
    for (var i = idx; i < end_idx; ++i)
        extracted_data.push(buffer[i]);
    if (byte_order === 'LE') extracted_data = extracted_data.reverse();
    var out = 0
    for (var j = 0; j < len; ++j) {
        out <<= 8
        out += extracted_data[j]
    }
    return out
}

/**
 * converts a number into a binary string; shamelessly ripped from :
 * @link https://qiita.com/rukihena/items/476d48e1e8d8fc6b98bf
 * @param {number} num
 * @param {number} length
 *      number of bytes of the final binary string; should be 1, 2, 4, ...
 * @return {string}
 *      returns a binary string; to convert to a buffer, use :
 *      <code>Buffer.from(int2strbinLE(XX, YY), 'ascii')</code>s
 */
function int2strbinLE(num, length) {
    var strbin = ''
    for (var i = 0; i < length; ++i) {
        strbin += String.fromCharCode(num & 0xff)
        num >>= 8
    }
    return strbin
}

module.exports = {
    range: range,
    serial: serial,
    int2strbinLE: int2strbinLE,
    read_number: read_number
}
