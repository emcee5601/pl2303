# pl2303

Prolific PL2303 user-space USB to serial adapter driver for Node.js

## Usage

```
const pl2303 = require('pl2303');
const { webusb } = require('usb');

const opts = {
    baudRate : 115200
};

(async () => {
    const device = await webusb.requestDevice({
        filters: [
        {
            vendorId: 1659,
            productId: 8963,
        },
        ],
    });

    let serial = new pl2303(device, opts);

    serial.on('data', data => console.log(data));
    serial.on('ready', () => serial.send(new Buffer('Hello!')));
})().catch((error) => {
    console.log('Error: ', error);
});
```