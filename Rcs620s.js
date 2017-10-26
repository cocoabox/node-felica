#!/usr/bin/env node

/**
 * a (very preliminary) node implementation of the RC-620S FeliCa reader serial communication
 * with minimal dependencies.
 *
 * NOTE : before using, you should :
 *
 * (0) install npm package "serialport" globally; this package requires
 *     the newest version of g++ (the Raspi3B should be fine without this step)
 *
 *      sudo apt-get install gcc-4.8 g++-4.8
 *      sudo update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-4.6 20
 *      sudo update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-4.8 50
 *      sudo update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-4.6 20
 *      sudo update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-4.8 50
 *
 *
 * (1) connect your RC-S620S to your Pi
 *      RC-S620:VDD --> Pi:5V or 3.3V rail
 *      RC-S620:GND --> Pi:GND
 *      RC-S620:RxD --> Pi:UART0-TxD
 *      RC-S620:TxD --> Pi:UART0-RxD
 *
 *
 * for the UART0-TxD and UART0-RxD pin number, google : Raspberry Pi GPIO
 * e.g. Raspi3B's UART0-TXD is pin #8 and UART0-RXD is pin #10
 *
 * (2) disable boot console in serial port ; modify /boot/cmdline.txt
 *      change 'console=ttyAMA0,115200' --> 'console=tty1'
 * (3) for Raspberry Pi 3 models, create/append to /boot.config.txt
 *      'dtoverlay=pi3-miniuart-bt'
 *
 * NOTE : lots of code was translated from :
 * @link https://qiita.com/rukihena/items/476d48e1e8d8fc6b98bf
 */

'use strict'

const SerialPort = require('serialport'),
    {range, serial, int2strbinLE, read_number} = require('./felicaca_utils')


// -- the following function is for debug only --
//function buffer2hex(buf) {
//    var out = []
//    for (const value of buf.values()) {
//        let o = Number(value).toString(16)
//        out.push(((o.length < 2) ? '0' : '') + o)
//    }
//    return out.join(' ')
//}

/**
 *
 * @param {...Buffer|string} _
 * @returns {Buffer}
 */
function concat_buffer(_) {
    var ingredients = []
    for (var i = 0; i < arguments.length; ++i) {
        var arg = arguments[i]
        if (arg instanceof Buffer) ingredients.push(arg);
        else if (typeof arg === 'number') ingredients.push(Buffer.from(String.fromCharCode(arg), 'ascii'));
        else if (typeof arg === 'string') ingredients.push(Buffer.from(arg, 'ascii'));
        else throw 'expecting number,string,Buffer ; received : ' + JSON.stringify(arg);
    }
    return Buffer.concat(ingredients)
}

// -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -
class Rcs620s {
    /**
     *
     * @param {string} port
     *      path to the unix port of the connection
     * @param {number} [baudrate=115200]
     * @param {function} [on_ready]
     *      called when the serial port is open and ready to use
     *      if omitted then you should inspect property: is_ready
     *      to determine when the serial port is ready for use
     * @param {number} [timeout=1000]
     *      felica timeout in milliseconds
     */
    constructor(port = '/dev/ttyAMA0', baudrate = 115200, on_ready = '', timeout = 1000) {
        //console.log(`creating SerialPort ; port = ${port}`)

        this._timeout = typeof timeout === 'number' && timeout ? timeout : 1000

        this._ser = new SerialPort(port, {baudRate: baudrate})

        this._busy = false

        this._on_ready = ''
        this._is_ready = false
        if (typeof on_ready === 'function') this._on_ready = on_ready;

        this._ser.on('open', () => {
            // console.log('now open')
            this._is_ready = true
            if (typeof this._on_ready === 'function')
                this._on_ready.apply(this);
        })

        /**
         * @type {Buffer}
         * @private
         */
        this._read_buffer = ''
        this._read_queue = []
        this._ser.on('data', buffer => {
            if (!this._read_buffer) {
                this._read_buffer = buffer
                //console.log(`[read-queue] received ${buffer.length} bytes =`, buffer)
                return
            }
            this._read_buffer = Buffer.concat([this._read_buffer, buffer])
            //console.log(`[read-queue] received ${buffer.length} bytes =`, this._read_buffer)
        })
        this._read_timer = setInterval(() => {
            if (!this._read_queue || !this._read_queue.length) return;

            //console.log(colors.magenta('read timer'))
            var read_req = this._read_queue[0],
                now = (new Date).getTime()

            if (now >= read_req.time_expire) {
                read_req.ng_callback('timeout')
                this._read_buffer.shift() // delete the first item from the queues
                return
            }

            if (!this._read_buffer) return;
            let bytes_to_take = this._read_buffer.length >= read_req.bytes_needed
                ? read_req.bytes_needed
                : this._read_buffer.length

            read_req.buffers.push(this._read_buffer.slice(0, bytes_to_take))
            read_req.bytes_needed -= bytes_to_take
            this._read_buffer = this._read_buffer.slice(bytes_to_take)

            // check if the request has fulfilled
            let out_buffer = Buffer.concat(read_req.buffers),
                check_ok

            if (!read_req.bytes_needed) {
                // no more bytes needed; perform a check then either accept or reject it
                if (read_req.check) {
                    check_ok = false
                    if ('function' === typeof read_req.check)
                        check_ok = read_req.check.apply(this, [out_buffer]);
                    else if ('string' === typeof read_req.check)
                        check_ok = read_req.check === out_buffer.toString('hex');
                    else
                        console.warn('[warn] expecting function or string in variable element "check" ; received : ',
                            read_req.check);
                }
                else check_ok = true;
                if (!check_ok) {
                    console.warn(`check failed; read_req.check=`, JSON.stringify(read_req.check))
                    read_req.ng_callback('check-failed')
                }
                // console.log(colors.green.bold('emitting buffer :'), out_buffer)
                read_req.ok_callback(out_buffer)
                this._read_queue.shift() // delete the first item from the queues
            }
        }, 10)
    }


    /**
     * @param {number} length
     *      number of bytes to expect to receive
     * @param {function|string} check
     *      if string, it must be a hex string, e.g. '00112233'
     *      if function, then the result Buffer is passed; to accept this data buffer, return TRUE
     * @param {number} [timeout]
     *      in millisecond
     * @return {Promise}
     *      if successful, resolves with : function(buffer) {..}
     *      if fail, rejects with : function(err_str) {..}
     * @protected
     */
    _read(length, check = '', timeout) {
        // console.log(`[read-queue] queuing read request for ${length} bytes`)

        if (typeof timeout !== 'number' || timeout) timeout = this._timeout;

        return new Promise((ok, ng) => {
            let now = (new Date).getTime()
            this._read_queue.push({
                time_in: now,
                time_expire: now + timeout,
                bytes_needed: length,
                buffers: [],
                check: check,
                ok_callback: ok,
                ng_callback: ng
            })
        })
    }

    close(timeout = 1000) {
        return new Promise((ok, ng) => {
            var timer = 0
            this._ser.on('close', () => {
                if (timer) clearTimeout(timer);
                ok()
            })
            this._ser.close()
            setTimeout(() => ng('timeout'), timeout)
        })
    }

    /**
     * @param {function} func
     */
    set on_ready(func) {
        if (typeof func === 'function') {
            this._on_ready = func;
            if (this._is_ready) func.apply(this);
        }
    }

    /**
     *
     * @return {boolean}
     */
    get is_ready() {
        return this._is_ready
    }


    /**
     *
     * @param {Buffer} buffer
     * @returns {Promise}
     *      if success, resolves with no arguments
     *      if fail, rejects with err_reason_str
     * @private
     */
    _write_serial(buffer) {
        if (!(buffer instanceof Buffer)) throw `expecting Buffer instance ; received : ${buffer}`;
        // console.log(colors.red.bold('writing :'), buffer2hex(buffer))
        return new Promise((ok, ng) => {
            if (this._ser) {
                this._ser.write(buffer)
                this._ser.drain(() => ok())
            }
            else ng('serial-port-not-ready');
        })
    }

    /**
     *
     * @param {...Buffer|string} _
     * @returns {Promise}
     * @private
     */
    _concat_and_write_serial(_) {
        let buffer = concat_buffer.apply(this, [].slice.call(arguments))
        return this._write_serial(buffer)
    }

    /**
     *
     * @param {number} length
     * @param {string} [encoding]
     *      if non-empty string, then response will be encoded in this encoding
     * @param {function} [check_func]
     *      should be : function (res_buffer_or_str) {..}
     *      return true to accept this response
     * @returns {Buffer|string|false}
     *      if fail returns false
     * @private
     */
    _read_serial(length, encoding, check_func) {
        console.log(`reading ${length} bytes from :`, this._data_in)

        let res = this._data_in_get(length)

        console.log('...', res)

        if (!res || !res.length) return false;
        if (encoding) res = res.toString(encoding);
        if (typeof check_func === 'function' && !check_func(res))  return false;
        console.log('read :', res)
        return res;
    }

    /**
     * @param {Buffer} buffer:
     * @return {number}
     */
    static _calculate_checksum(buffer) {
        var check_sum = 0
        for (const value of buffer.values()) {
            check_sum += value
        }
        // console.log('sum:', check_sum)
        let dcs = (-check_sum) & 0xff
        // console.log('dcs:', dcs)
        return dcs
    }

    /**
     *
     * @param {string|Buffer} command
     * @return {Promise}
     * @private
     */
    _card_command(command) {
        // console.log(colors.bgBlue.cyan.bold('[ex-commmand]'), command)

        return new Promise((ok, ng) => {
            let command_timeout = this._timeout >= (0x10000 / 2) ? 0xffff : this._timeout * 2,
                command_buffer = concat_buffer(
                    '\xd4\xa0',
                    int2strbinLE(command_timeout, 2),
                    String.fromCharCode(command.length + 1),
                    command
                )
            this._rw_command(command_buffer, buf =>
                buf.length >= 4
                && buf.toString('hex').indexOf('d5a100') === 0
                && buf.length === buf[3] + 3
            ).then(
                buffer => {
                    let card_command_out = buffer.slice(4)
                    // console.log(colors.bgBlue.cyan.bold('[ex-commmand OK]'), card_command_out)
                    ok(card_command_out)
                },
                error => ng({error: 'ex-command-failed', error2: error})
            )
        })
    }

    /**
     * @param {string|Buffer} command to send
     * @param {function|string} [check]
     *      if function, then the result Buffer will be passed; you should return a true to indicate acceptance
     *      if string, then the buffer is converted to string and compared against this string
     * @return {Promise}
     *      if success, resolves with : function (result_buffer) {..}
     *      if fail, rejects with : function (err_string) {..}
     *
     */
    _rw_command(command, check) {
        return new Promise((overall_ok, overall_ng) => {
            var me = this,
                self = this.constructor,
                send_buffer = command instanceof Buffer ? command : Buffer.from(command, 'ascii'),
                len = send_buffer.length,
                dcs = self._calculate_checksum(send_buffer)

            //console.log('-------------------------------------\nwill send command :', buffer2hex(send_buffer))

            this._data_in = ''
            this._ser.flush(() => {
                //
                // 0. send: payload length
                // 1. send: payload
                // 2. send: checksum
                // 3. recv: 6-byte response
                //

                let req = '\x00\x00\xff',
                    promise0
                if (len <= 255) {
                    // normal frame
                    promise0 = me._concat_and_write_serial(req,
                        String.fromCharCode(len),
                        String.fromCharCode((-len) & 0xff))
                }
                else {
                    // extended frame
                    // 未テストです
                    let buffer1 = concat_buffer(req, '\xff\xff',
                        String.fromCharCode((len >> 8) & 0xff),
                        String.fromCharCode((len >> 0) & 0xff)
                    )
                    promise0 = me._concat_and_write_serial(buffer1,
                        String.fromCharCode(self._calculate_checksum(buffer1.slice(2)))
                    )
                }

                promise0.then(
                    () => {
                        let promise1 = me._write_serial(send_buffer)
                        promise1.then(
                            () => {
                                let promise2 = me._concat_and_write_serial(dcs, '\x00')
                                promise2.then(
                                    () => {
                                        // receive an ACK
                                        // console.log(colors.blue('expecting ack'))
                                        me._read(6, '0000ff00ff00').then(
                                            res_buffer => {
                                                // console.log(colors.blue.bold('got ack'))
                                                // got an ACK! receive a message
                                                me._read(5, buf => buf.toString('hex').indexOf('0000ff') === 0).then(
                                                    response_body => {
                                                        // got a message; determine response length
                                                        let response_len = 0
                                                        if (response_body[3] === 0xff && response_body[4] === 0xff) {
                                                            // ???
                                                            response_body = this._read_serial(3)
                                                            if (!response_body || self._calculate_checksum(response_body) !== 0)
                                                                return this._cancel().then(() => overall_ng('response-checksum-error'));
                                                            response_len = String.fromCharCode(
                                                                (response_body[5] << 8) | (response_body[6] << 0))
                                                        }
                                                        else {
                                                            if (self._calculate_checksum(response_body.slice(3)) !== 0)
                                                                return this._cancel().then(() => overall_ng('response-checksum-error'));
                                                            response_len = response_body[3];
                                                        }
                                                        if (response_len > self.MAX_RW_RESPONSE_LEN)
                                                            return this._cancel().then(() => overall_ng('response-too-long'));

                                                        // wait for response body
                                                        // console.log(colors.blue(`reading response : ${response_len} bytes`))
                                                        me._read(response_len).then(
                                                            response_body => {
                                                                // console.log(colors.blue.bold(`got response :`), response_body)
                                                                // got response body; compute DCS
                                                                let dcs = self._calculate_checksum(response_body)
                                                                // console.log('* response DCS :', dcs)
                                                                // compare DCS with provided one , which we will read now..
                                                                me._read(2, buf => buf[0] === dcs && buf[1] === 0x00).then(
                                                                    dcs_buffer => {
                                                                        // checksum OK
                                                                        if (check) {
                                                                            let check_ok = false
                                                                            if (typeof check === 'function')
                                                                                check_ok = check.apply(this, [response_body]);
                                                                            else if (typeof check === 'string')
                                                                                check_ok = response_body.toString('hex') === check;
                                                                            else
                                                                                console.warn('expecting string or function in "check"; received :', check);
                                                                        }
                                                                        if (!check)
                                                                            return this._cancel().then(() => overall_ng('check-failed'));

                                                                        // check OK
                                                                        return overall_ok(response_body)
                                                                    },
                                                                    err => this._cancel().then(() => overall_ng({
                                                                        error: 'response-checksum-invalid',
                                                                        error2: err
                                                                    }))
                                                                )
                                                            },
                                                            err => this._cancel().then(() => overall_ng({
                                                                error: 'read-response-failed',
                                                                error2: err
                                                            }))
                                                        )

                                                    },
                                                    err => this._cancel().then(() => overall_ng({
                                                        error: 'no-valid-message',
                                                        error2: err
                                                    }))
                                                )
                                            },
                                            err => this._cancel().then(() => overall_ng({
                                                error: 'no-ack',
                                                error2: err
                                            }))
                                        )
                                    },

                                    err => overall_ng({error: 'promise2-failed', error2: err})
                                )   // promise2.then
                            },
                            err => overall_ng({error: 'promise1-failed', error2: err})
                        ) // promise1.then
                    },
                    err => overall_ng({error: 'promise0-failed', error2: err})
                )  // promise0.then
            })  // flush
        })
    }   // end _send_and_receive

    /**
     * sends a cancel, duh
     * @returns {Promise}
     *      if successful, resolves with no arguments;
     *      if fail, resolves with one argument: err_str
     * @private
     */
    _cancel() {
        var me = this
        return new Promise(ok => {
//            console.log('sending cancel command ...')
            me._concat_and_write_serial('\x00\x00\xff\x00\xff\x00').then(
                () => {
                    setTimeout(() => {
                        me._ser.flush()
                        me._data_in = ''
                        ok()
                    }, 10)
                },
                err_str => ok(err_str)
            )
        })
    }

    init_device() {
        let me = this
        return new Promise((ok, ng) => {
            // console.log('serial port is now open')

            // 1. open device
            me._rw_command('\xd4\x32\x02\x00\x00\x00', 'd533').then(
                response_buffer1 => {
                    // console.log('## open device OK')
                    // 2. RFConfiguration (max retries)
                    me._rw_command('\xd4\x32\x05\x00\x00\x00', 'd533').then(
                        response_buffer2 => {
                            // console.log('## RFConfiguration OK')
                            // RFConfiguration (additional wait time = 24ms)
                            this._rw_command('\xd4\x32\x81\xb7', 'd533').then(
                                response_buffer3 => {
                                    // console.log('## RFConfiguration 2 OK')
                                    ok()
                                },
                                err => ng({error: 'RFConfiguration-2-failed', error2: err})
                            )
                        },
                        err => ng({error: 'RFConfiguration-1-failed', error2: err})
                    )
                },
                err => ng({error: 'open-device-failed', error2: err})
            )
        })
    }

    polling(system_code) {
        if (this._busy)
            return new Promise((ok, ng) => ng('busy'));

        this._busy = true
        // console.log("### polling")
        let me = this
        return new Promise((ok, ng) => {
            me._rw_command(
                concat_buffer('\xd4\x4a\x01\x01\x00', system_code, '\x00\x0f'),
                buf => {
                    let hex = buf.toString('hex');
                    return buf && (
                            hex.indexOf('d54b01011201') === 0 || hex.indexOf('d54b00') === 0
                        )
                }
            ).then(
                response_buffer1 => {
                    me._busy = false

                    let hex = response_buffer1.toString('hex');
                    if (hex.indexOf('d54b01011201') === 0) {
                        let idm = response_buffer1.slice(6, 6 + 8),
                            pmn = response_buffer1.slice(14, 14 + 8)
                        ok({idm: idm, pmn: pmn})
                    }
                    else ok();
                },
                err => {
                    me._busy = false
                    ng({error: 'InListPassiveTarget-failed', error2: err})
                }
            )
        })
    }

    /**
     *
     * @param {...Buffer|string} _
     * @returns {Buffer}
     * @private
     */
    static _concat_buffer(_) {
        let concat_from = []
        for (let i = 0; i < arguments.length; ++i) {
            let arg = arguments[i]
            concat_from.push(arg instanceof Buffer ? arg : new Buffer(arg, 'ascii'))
        }
        return Buffer.concat(concat_from)
    }


    _request_service(idm, service_code) {
        let me = this,
            self = this.constructor

        return new Promise((ok, ng) => {
            // construct command : 02 <IDM> 01 <SERVICE_CODE>
            let command = self._concat_buffer('\x02', idm, '\x01', service_code),
                res_prefix_expected = self._concat_buffer('\x03', idm).toString('hex')
            // console.log('requesting service; sending command:', command, '; expecting res-prefix:', res_prefix_expected)
            // console.log(colors.bgMagenta.yellow.bold('sending card-command'))
            this._card_command(command, buf => {
                    // console.log(colors.bgMagenta.yellow.bold('request-service : checking buffer: '), buf)
                    return buf
                        && buf.length === 12
                        && buf.toString('hex').indexOf(res_prefix_expected) === 0
                        && buf.slice(10).toString('hex') !== 'ffff'
                }
            ).then(
                response_buffer => ok(),
                err => ng({error: 'request-service-failed', error2: err})
            )
        })

    }

    _read_without_encryption(idm, service_code, block_number) {
        // 暗号化なしで読む
        let me = this,
            self = this.constructor
        return new Promise((ok, ng) => {
            let command = self._concat_buffer('\x06', idm, '\x01', //  サービス数
                service_code, '\x01',// ブロック数(なぜか複数指定するとエラーが返る)
                '\x80', String.fromCharCode(block_number)
                ),
                res_prefix_expected = self._concat_buffer('\x07', idm).toString('ascii')

            this._card_command(command, buf =>
                buf && buf.length === 28
                && (buf.toString('ascii').indexOf(res_prefix_expected) === 0)
            ).then(
                response_buffer => ok(response_buffer.slice(12)),
                err => ng({error: 'rw-command-failed', error2: err})
            )
        })
    }

    _read_without_encryption2(idm, service_code, block_number, length) {
        let me = this
        me._busy = true
        // console.log(colors.bgCyan.yellow.bold(`read without encryption; block ${block_number} , len ${length}`))
        return new Promise((ok, ng) => {
            let tasks = range(length).map(
                i => {
                    return () => new Promise((task_ok, task_ng) => {
                        me._read_without_encryption(idm, service_code, block_number + i).then(
                            buf => task_ok(buf),
                            err => {
                                console.warn(colors.bgRed.yellow.bold(`read-without-encryption-failed ; block: ${block_number + i} ; error :`), err)
                                return task_ng({
                                    error: 'read-without-encryption-failed',
                                    error2: err,
                                    block_number: block_number + i
                                })
                            }
                        )
                    })
                }
            )
            serial(tasks).then(
                results => {
                    me._busy = false
                    // console.log('tasks completed!')
                    ok(Buffer.concat(results))
                },
                err => {
                    me._busy = false
                    return ng({error: 'read-without-encryption2-task-error', error2: err})
                }
            )
        })
    }


    read_block(idm, service_code, block_number, length) {
        // console.log(colors.bgWhite.black(' ### reading block ### '))
        // 存在確認してから読む
        let me = this
        return new Promise((ok, ng) => {
            me._request_service(idm, service_code).then(
                () => {
                    // console.log(colors.bgMagenta.yellow.bold('request service OK!'))
                    me._read_without_encryption2(idm, service_code, block_number, length).then(
                        buf => ok(buf),
                        err => ng({error: 'read-without-encryption2-failed', error2: err})
                    )
                },
                err => ng({error: 'request-service-failed', error2: err})
            )
        })
    }

    read_service(idm, sevice) {
        var self = this.constructor
        if (!sevice.service_code || !sevice.blocks)
            throw 'expecting service_dict to be {service_code:xx, blocks:xx}';
        return new Promise((read_service_ok, read_service_ng) => {

            let service_code = sevice.service_code,
                blocks = sevice.blocks,
                processing = sevice.processing,
                funcs = [];

            for (let i = 0; i < blocks; ++i) {
                funcs.push(() => this.read_block(idm, service_code, i, blocks))
            }
            //  run each func sequentially
            serial(funcs).then(
                results => read_service_ok(processing(results)),
                err => read_service_ng(err)
            )
        })
    }


}

Rcs620s.SYSTEM_CODE = {
    SUICA: '\x00\x03',
    COMMON: '\xfe\x00',
    SETAMARU: '\x80\x2B',
    IRUCA: '\x80\xDE'
}

Rcs620s.SERVICES = {
    SUICA: {
        // 属性情報 : http://jennychan.web.fc2.com/format/suica.html#008B
        PROPERTIES: {
            service_code: '\x8b\x00', blocks: 1, processing: results => {
                let data = results[0]
                if (!data) return;
                return {
                    // card_type: 'wip',
                    // card_region: 'wip',
                    balance: read_number(data, 11, 2, 'LE')
                }
            }
        },
        // -- below are work in progress --
        USAGE_HISTORY: {service_code: '\x0f\x09', blocks: 20}, // 利用履歴
        TICKET_HISTORY: {service_code: '\x8f\x10', blocks: 3}, // 改札入出場履歴
        SF_TICKET_HISTORY: {service_code: '\xcb\x10', blocks: 3}, // SF入場駅記録
        FARE_HISTORY: {service_code: '\x4b\x81', blocks: 36} // 料金 発券/改札記録
    }
}

Rcs620s.MAX_RW_RESPONSE_LEN = 265

module.exports = Rcs620s
