/*
 * Copyright for portions of usbserial are held by Andreas Gal (2017) as part
 * of pl2303. All other copyright for pl2303 are held by Tidepool Project (2018).
 *
 * Prolific PL2303 user-space USB driver for Node.js
 *
 * SPDX-License-Identifier: MIT
 */

enum FlowControl { NONE, RTS_CTS, DTR_DSR, XON_XOFF, XON_XOFF_INLINE }


const SupportedBaudrates = [
    75, 150, 300, 600, 1200, 1800, 2400, 3600,
    4800, 7200, 9600, 14400, 19200, 28800, 38400,
    57600, 115200, 230400, 460800, 614400,
    921600, 1228800, 2457600, 3000000, 6000000,
];

const READ_TIMEOUT_MS = 1000
const WRITE_TIMEOUT_MS = 5000

const SET_CONTROL_REQUEST = 0x22;

/* SET_CONTROL_REQUEST */
const CONTROL_DTR = 0x01;
const CONTROL_RTS = 0x02;

const VENDOR_READ_REQUEST = 0x01;
const VENDOR_WRITE_REQUEST = 0x01;
const VENDOR_READ_HXN_REQUEST = 0x81;
const VENDOR_WRITE_HXN_REQUEST = 0x80;

const RESET_HXN_REQUEST = 0x07;
const FLUSH_RX_REQUEST = 0x08;
const FLUSH_TX_REQUEST = 0x09;

/* RESET_HXN_REQUEST */
const RESET_HXN_RX_PIPE = 1;
const RESET_HXN_TX_PIPE = 2;


enum DeviceType {
    DEVICE_TYPE_01,
    DEVICE_TYPE_T,
    DEVICE_TYPE_HX,
    DEVICE_TYPE_HXN
}

export default class ProlificUsbSerial extends EventTarget {
    private readonly device: USBDevice;
    private iface: USBInterface | undefined;
    private isClosing: boolean = false;
    private bitrate: number = 9600;
    private readEndpoint: USBEndpoint | undefined;
    private writeEndpoint: USBEndpoint | undefined;
    private deviceType: DeviceType = DeviceType.DEVICE_TYPE_HX;
    private currentFlowControl: FlowControl = FlowControl.NONE;
    private currentControlLinesValue: number = CONTROL_RTS | CONTROL_DTR;

    constructor(device: USBDevice, opts: { baudRate: number }) {
        super();
        this.bitrate = opts.baudRate;
        this.device = device;
        // assert(this.device.deviceClass !== 0x02);
    }

    async controlTransferInWithTimeout({requestType, recipient, request, value, index}: {
                                           requestType: USBRequestType,
                                           recipient: USBRecipient,
                                           request: number,
                                           value: number,
                                           index: number
                                       },
                                       expectedBytes: number,
                                       timeout: number = READ_TIMEOUT_MS): Promise<ArrayBufferLike> {
        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            const abortListener:EventListener = (event) => {
                abortController.signal.removeEventListener('abort', abortListener);
                reject(event.target)
            }
            abortController.signal.addEventListener('abort', abortListener);
            setTimeout(() => {
                abortController.abort("controlTransferIn timed out")
            }, timeout);

            this.device.controlTransferIn({
                requestType,
                recipient,
                request,
                value,
                index
            }, expectedBytes).then(result => {
                if (abortController.signal.aborted) {
                    reject(`aborted, but we finally got our result: ${JSON.stringify(result)}`);
                } else if (result.data?.byteLength === expectedBytes) {
                    resolve(result.data.buffer);
                } else {
                    reject("controlTransferIn succeeded, but did not receive expected number of bytes")
                }
            }).catch(reject)
        })
    }

    async controlTransferOutWithTimeout({requestType, recipient, request, value, index, data}: {
                                            requestType: USBRequestType,
                                            recipient: USBRecipient,
                                            request: number,
                                            value: number,
                                            index: number,
                                            data: BufferSource|undefined
                                        },
                                        timeout: number = WRITE_TIMEOUT_MS): Promise<string> {
        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            const abortListener:EventListener = (event) => {
                abortController.signal.removeEventListener('abort', abortListener);
                reject(event.target)
            }
            abortController.signal.addEventListener('abort', abortListener);
            setTimeout(() => {
                abortController.abort("controlTransferOut timed out")
            }, timeout);

            this.device.controlTransferOut({requestType, recipient, request, value, index}, data).then(result => {
                if (abortController.signal.aborted) {
                    reject(`aborted, but we finally got our result: ${JSON.stringify(result)}`);
                } else if (result.bytesWritten === (data? data.byteLength: 0)) {
                    resolve(result.status);
                } else {
                    reject("controlTransferOut succeeded, but did not write expected number of bytes")
                }
            }).catch(reject)
        })
    }

    async testHxStatus(): Promise<boolean> {
        return this.controlTransferInWithTimeout({
            requestType: 'vendor',
            recipient: 'device',
            request: VENDOR_READ_REQUEST,
            value: 0x8080,
            index: 0
        }, 1)
            .then(() => {
                return true;
            }).catch(() => {
                // ignore
                return false;
            })
    }

    async vendorRead(value: number, index: number) {
        const request = this.deviceType === DeviceType.DEVICE_TYPE_HXN ? VENDOR_READ_HXN_REQUEST : VENDOR_READ_HXN_REQUEST;
        const buffer = await this.device.controlTransferIn({
            requestType: 'vendor',
            recipient: 'device',
            request: request,
            value,
            index,
        }, 1);

        return buffer.data?.buffer;
    }

    async vendorWrite(value: number, index: number) {
        const request = this.deviceType === DeviceType.DEVICE_TYPE_HXN ? VENDOR_WRITE_HXN_REQUEST : VENDOR_WRITE_REQUEST
        await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'device',
            request: request,
            value,
            index,
        }).then(result => {console.log(`vendorWrite success ${JSON.stringify(result)}`)})
            .catch(reason => {console.warn(`vendorWrite failed ${reason}`)});
    }


    async setBaudRate(baud: number) {
        // assert(baud <= 115200);
        // find the nearest supported bitrate
        const list = SupportedBaudrates.slice().sort((a, b) => Math.abs(a - baud) - Math.abs(b - baud));
        const newBaud = list[0];
        await this.device.controlTransferIn({
            requestType: 'class',
            recipient: 'interface',
            request: 0x21,
            value: 0,
            index: 0,
        }, 7);

        console.log('Setting baud rate to', newBaud);

        const data = new ArrayBuffer(7);
        const parameters = new DataView(data);
        parameters.setInt32(0, newBaud, true);
        parameters.setUint8(4, 0); // 1 stop bit
        parameters.setUint8(5, 0); // no parity
        parameters.setUint8(6, 8); // 8 bit characters
        await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: 0,
        }, parameters);
    }

    async purgeHwBuffers(purgeWriteBuffers: boolean, purgeReadBuffers: boolean) {
        if (this.deviceType === DeviceType.DEVICE_TYPE_HXN) {
            let index = 0;
            if (purgeWriteBuffers) {
                index |= RESET_HXN_RX_PIPE
            }
            if (purgeReadBuffers) {
                index |= RESET_HXN_TX_PIPE
            }
            if (index !== 0) {
                await this.vendorWrite(RESET_HXN_REQUEST, index)
            }

        } else {
            if (purgeWriteBuffers) {
                await this.vendorWrite(FLUSH_RX_REQUEST, 0)
            }
            if (purgeReadBuffers) {
                await this.vendorWrite(FLUSH_TX_REQUEST, 0)
            }
        }
    }

    async resetDevice() {
        return this.purgeHwBuffers(true, true);
    }


    async open() {
        (async () => {
            await this.device.open();
            // assert(this.device.configuration.interfaces.length === 1);

            [this.iface] = this.device.configuration ? this.device.configuration.interfaces : [];
            console.log('Claiming interface', this.iface.interfaceNumber);
            await this.device.claimInterface(this.iface.interfaceNumber);

            // determine read and write interfaces
            this.iface.alternate.endpoints.forEach((endpoint) => {
                switch (endpoint.direction) {
                    case "in":
                        this.readEndpoint = endpoint;
                        break
                    case "out":
                        this.writeEndpoint = endpoint;
                        break;
                    default:
                        console.error(`endpoint ${endpoint.endpointNumber} has unexpected direction: ${endpoint.direction}`);
                        break;
                }
            })


            // determine device type
            const descriptorResult = await this.device.controlTransferIn({
                requestType: 'standard',
                recipient: 'device',
                request: 0x06,
                value: 0x0100,
                index: 0x0000
            }, 255)
            const rawDescriptors = descriptorResult.data
            if (!rawDescriptors || rawDescriptors.byteLength < 14) {
                throw "Could not get device descriptors."
            }
            const usbVersion = this.device.usbVersionMajor
            const deviceVersion = this.device.deviceVersionMajor
            const maxPacketSize = rawDescriptors.getInt8(7)
            if (this.device.deviceClass === 0x02 || maxPacketSize != 64) {
                this.deviceType = DeviceType.DEVICE_TYPE_01;
            } else if (usbVersion === 0x200) {
                const hxStatus = await this.testHxStatus();
                if (hxStatus && deviceVersion === 0x300) {
                    this.deviceType = DeviceType.DEVICE_TYPE_T;
                } else if (hxStatus && deviceVersion === 0x500) {
                    this.deviceType = DeviceType.DEVICE_TYPE_T;
                } else {
                    this.deviceType = DeviceType.DEVICE_TYPE_HXN;
                }
            } else {
                this.deviceType = DeviceType.DEVICE_TYPE_HX
            }

            await this.resetDevice()
            await this.doBlackMagic()
            await this.setControlLines(this.currentControlLinesValue)
            await this.setFlowControl(this.currentFlowControl)
            await this.setBaudRate(this.bitrate);

            this.isClosing = false;
            await this.readLoop();

            await this.setFlowControl(FlowControl.RTS_CTS)
            await this.setControlLines(0xff) // set all the lines
            // maybe these are needed?
            // await this.setRTS(true) // CTS
            // await this.setDTR(true) // DSR

            this.dispatchEvent(new Event('ready'));
        })().catch((error) => {
            console.log('Error during PL2303 setup:', error);
            this.dispatchEvent(new CustomEvent('error', {
                detail: error,
            }));
        });
    }

    private async readLoop() {
        if (!this.readEndpoint) {
            console.error("no read endpoint, aborting readLoop()")
            await this.close();
            return
        }
        this.device.transferIn(this.readEndpoint.endpointNumber, 64).then((result) => {
            if (result && result.data && result.data.byteLength) {
                console.log(`Received ${result.data.byteLength} byte(s).`);
                const uint8buffer = new Uint8Array(result.data.buffer);
                this.dispatchEvent(new CustomEvent('data', {
                    detail: uint8buffer.slice(0),
                }));
            } else {
                console.log("transferIn got no result, no result data, or data was empty")
            }

        }).catch((error) => {
                if (error.message.indexOf('LIBUSB_TRANSFER_NO_DEVICE')) {
                    console.warn('Device disconnected');
                    this.dispatchEvent(new Event('disconnected'));
                    this.isClosing = true; // flag this so we don't keep hitting this error
                } else {
                    console.error('Error reading data:', error);
                }
            }
        ).finally(async () => {
            if (!this.isClosing && this.device.opened) {
                await this.readLoop();
            }
        })
    }

    async close() {
        this.isClosing = true;
        this.dispatchEvent(new Event('disconnected'));
        return new Promise<void>((resolve, reject) => {
            setTimeout(async () => {
                try {
                    await this.device.releaseInterface(0);
                    await this.device.close();
                    resolve();
                } catch (err) {
                    console.error('Error while closing:', err);
                    reject(err);
                }
            }, 2000);

        })
    }

    async write(data: BufferSource): Promise<USBOutTransferResult> {
        return new Promise((resolve, reject) => {
            if (!this.writeEndpoint) {
                reject("no writeEndpoint");
                return;
            }
            this.device.transferOut(this.writeEndpoint?.endpointNumber, data).then(() => {
                resolve({status: "ok", bytesWritten: data.byteLength});
            }).catch((err) => {
                console.error(`error writing to ${this.device.constructor.name}: ${err}`)
                reject(err)
            })
        })
    }

    private async doBlackMagic() {
        if (this.deviceType === DeviceType.DEVICE_TYPE_HXN) {
            return
        }
        await this.vendorRead(0x8484, 0); // todo: rewrite these to check for response length?
        await this.vendorWrite(0x0404, 0);
        await this.vendorRead(0x8484, 0);
        await this.vendorRead(0x8383, 0);
        await this.vendorRead(0x8484, 0);
        await this.vendorWrite(0x0404, 1);
        await this.vendorRead(0x8484, 0);
        await this.vendorRead(0x8383, 0);
        await this.vendorWrite(0, 1);
        await this.vendorWrite(1, 0);
        if (this.deviceType === DeviceType.DEVICE_TYPE_01) {
            await this.vendorWrite(2, 0x24);
        } else {
            await this.vendorWrite(2, 0x44);
        }
    }

    private async setFlowControl(flowControl: FlowControl) {
        console.log(`setFlowControl ${flowControl}`)
        // vendorOut values from https://www.mail-archive.com/linux-usb@vger.kernel.org/msg110968.html
        switch (flowControl) {
            case FlowControl.NONE:
                if (this.deviceType === DeviceType.DEVICE_TYPE_HXN) {
                    await this.vendorWrite(0x0a, 0xff)
                } else {
                    await this.vendorWrite(0, 0)
                }
                break;
            case FlowControl.RTS_CTS:
                if (this.deviceType == DeviceType.DEVICE_TYPE_HXN)
                    await this.vendorWrite(0x0a, 0xfa);
                else
                    await this.vendorWrite(0, 0x61);
                break;
            case FlowControl.XON_XOFF_INLINE:
                if (this.deviceType == DeviceType.DEVICE_TYPE_HXN)
                    await this.vendorWrite(0x0a, 0xee);
                else
                    await this.vendorWrite(0, 0xc1);
                break;
            default:
                throw `Unsupported flow control: ${flowControl}`
        }
        this.currentFlowControl = flowControl;
    }

    public async setDTR(value:boolean) {
        let newControlLines:number;
        if(value) {
            newControlLines = this.currentControlLinesValue | CONTROL_DTR
        } else {
            newControlLines = this.currentControlLinesValue & ~CONTROL_DTR
        }
        await this.setControlLines(newControlLines)
    }

    public async setRTS(value:boolean) {
        let newControlLines:number;
        if(value) {
            newControlLines = this.currentControlLinesValue | CONTROL_RTS
        } else {
            newControlLines = this.currentControlLinesValue & ~CONTROL_RTS
        }
        await this.setControlLines(newControlLines)
    }

    private async setControlLines(newControlLinesValue: number) {
        await this.controlTransferOutWithTimeout({
            requestType:"class",
            recipient:"interface",
            request:SET_CONTROL_REQUEST,
            value:newControlLinesValue,
            index:0,
            data:undefined})
        this.currentControlLinesValue = newControlLinesValue
    }
}
