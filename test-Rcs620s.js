#!/usr/bin/env node

'use strict'

const Rcs620s = require('./Rcs620s')

var reader

function bye() {
    reader.close().then(() => {
        console.log('good-bye')
        process.exit(0)
    }).catch(err => {
        console.warn('error closing serial port :', err)
        process.exit(1)
    })
}
process.on('SIGINT', bye)

reader = new Rcs620s('/dev/ttyAMA0', 115200, function () {
    this.init_device().then(
        () => {
            console.log('● device is ready ; place a SUICA on the your RC-S620S to get info (^C to exit)')
            // poll every 300 ms ; if an existing command/poll is in progress
            // then polling will reject with err=='busy'
            setInterval(() => {
                this.polling(Rcs620s.SYSTEM_CODE.SUICA).then(
                    // poll successful, print card IDm to console
                    // and try to get SUICA balance
                    data => {
                        if (data) {
                            process.stdout.write('\x07') // beep
                            console.log('● card IDm :', data.idm.toString('hex'))
                            // TODO : read sequentially SUICA, EDY, WAON, ...
                            this.read_service(data.idm, Rcs620s.SERVICES.SUICA.PROPERTIES).then(
                                output => {
                                    console.log(`● SUICA balance ￥${output.balance}`)
                                    bye()
                                },
                                err => console.warn('error reading service', err)
                            )
                        }
                    },
                    // only emit an error to console if the poll failed with reasons
                    // other than "busy"
                    err => (err !== 'busy') && console.warn('poll failed :', err)) // this.polling
            }, 300) // setInterval
        },
        err => {
            console.warn('init device failed :', err)
            bye()
        }
    )
})


