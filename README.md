![Logo](admin/midea-heatpump.png)

# ioBroker.midea-heatpump

**[Deutsche Version](README.de.md)**

ioBroker adapter for Midea air-to-water heat pumps (M-Thermal protocol) via Modbus – directly over RS-485, via Modbus TCP, or as RTU frames over TCP (e.g. an ESP32 bridge running `stream_server`).

## Supported models

| Model                                                              | Status |
| ------------------------------------------------------------------ | ------ |
| Midea MHC-V8WD2RN7 (R290, 8 kW, monoblock, backup heater 3/6/9 kW) | tested |

The model cannot be detected automatically via Modbus, so you select it in the instance configuration. At startup the adapter checks the "unit capacity" register (123) and logs a warning if it does not match the selected model.

### Adding more models

1. Create a file in `lib/models/`. Common registers and mappings come from `midea-common.js`; with `extendModel()` you describe only the differences (capacity, backup heater stages, invalid addresses, additional or missing registers).
2. Add the model to `lib/models/index.js`.
3. Add it to the dropdown in `admin/jsonConfig.json`.

## Features

- **Named data points**: temperatures, operation, status bits, service menu settings, heating curve. Each register appears exactly once. Registers without a mapping can optionally be created as raw values under `Register.*`.
- **Robust polling**:
    - Live values (registers < 200) are read every cycle, settings (≥ 200) less often.
    - If an answer is missing, the request is repeated without closing the connection. The adapter only reconnects after 3 unanswered requests in a row.
    - The pause between two requests is configurable.
    - Addresses rejected by the device ("Illegal Data Address") are learned and skipped from then on (`info.invalidAddresses`).
- **Statistics** (persist across restarts):
    - Electricity consumption per operating mode (heating / hot water / standby) from a calibrated electricity meter
    - Heat per operating mode from a heat meter, split by power or runtime
    - COP per day and operating mode
    - Daily values of the internal device counters, kept separately under `Tageswerte.WP intern`
    - Compressor starts and runtime per day and operating mode, average runtime per start
    - Backup heater: current power, estimated energy and runtime per day
    - Disinfection detection (the heat pump does not report a running disinfection)
    - Flow setpoint from heating curve or fixed setpoint, flow/return temperature difference
- **Heat meter fast polling** (optional): a boolean data point is set while the heat pump is heating or producing hot water, plus a follow-up time.
- **Writing** (only if enabled in the configuration):
    - DHW setpoint
    - fixed flow setpoint zone 1 (limits from registers 203/204)
    - force DHW
    - DHW on/off
    - zone 1 on/off
    - heating curve
    - silent mode and silent mode level
    - ECO mode
    - climate curve zone 1
    - custom heating curve (T1SetH1/2, T4H1/2)

    Values outside the limits are rejected. Bit fields are read fresh, one bit is changed and the value is written back. After every write the register is read back and the data point is acknowledged.

Data point names are in German (e.g. `Temperaturen.Vorlauf` = flow temperature, `Tageswerte` = daily values), matching the original Node-RED flow this adapter replaces.

## Configuration (example: ESP bridge)

| Setting                | Value                                            |
| ---------------------- | ------------------------------------------------ |
| Connection type        | RTU over TCP                                     |
| IP / port              | IP of the bridge, stream_server port (e.g. 5021) |
| Unit ID                | 1                                                |
| Poll interval          | 10 s                                             |
| Settings interval      | 300 s                                            |
| Response timeout       | 3000 ms                                          |
| Pause between requests | 250 ms                                           |
| Retries                | 1                                                |
| Max. address gap       | 0                                                |

Note: a stream_server usually serves only one client per port. The ioBroker modbus adapter must not access the same port at the same time.

## Migration from the Node-RED flow

`tools/migration_von_flow.js` (ioBroker JavaScript script) copies the current daily values and the InfluxDB settings, keeping the same aliases, from `0_userdata.0.Wärmepumpe.*` to the adapter's data points. Grafana keeps working unchanged. Run it once with `DRY_RUN = true` first.

## Troubleshooting

Set the instance log level to **debug** to see:

- every Modbus request with its response time (`FC03 104+16: ok in 87 ms`), missing answers and retries,
- one summary line per poll cycle (`Cycle: 22/22 blocks ok, 5 values changed, 1450 ms, slowest answer 120 ms`),
- with the option _Log raw register values_ additionally every received block as raw numbers.

The states under `info.*` (requests, timeouts, retries, cycle duration, slowest answer) are always available.

## Installation

```bash
iob url https://github.com/MMeinhardt1/ioBroker.midea-heatpump
iob add midea-heatpump
```

## Changelog

### 0.2.1 (2026-11-17)

- Translations of the admin interface (`admin/i18n`) and of title, description and news in `io-package.json` for es, fr, it, nl, pl, pt, ru, uk and zh-cn (previously English text in these languages)

### 0.2.0 (2026-11-16)

- Detailed debug logging: response time of every request, one summary line per poll cycle, optional raw register dump (new option _Log raw register values_)
- New state `info.responseMsMax` (slowest answer in the last poll cycle)
- IP address / host name is checked in the admin UI (cannot be saved when invalid) and cleaned up at start-up (e.g. a trailing comma)
- New instances are created disabled, so they do not start before they are configured
- A GitHub release with these notes is created automatically for every new version (no npm publishing)

### 0.1.0 (2026-11-15)

- Initial release: Midea MHC-V8WD2RN7, statistics from the previous Node-RED flow, write support with limit checks

## License

MIT License

Copyright (c) 2026 MMeinhardt1

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
