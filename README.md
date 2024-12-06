# pl2303

Prolific PL2303 user-space USB to serial adapter driver for Node.js

## Usage

```
import ProlificUsbSerial from "pl2303"

const decoder = new TextDecoder();
navigator.usb.requestDevice({filters: [{vendorId: 1659, productId: 9123}]})
  .then(device => {
    const serial = new ProlificUsbSerial(device, {baudRate: 9600});
    serial.addEventListener('data', (event) => {
        const chunk: Uint8Array = (event as CustomEvent).detail;
        console.log(decoder.decode(chunk));
        serial.write(chunk)
          .then((res) => console.log(`success: ${res}`))
          .catch((err) => console.log(err));
    })
})

```
