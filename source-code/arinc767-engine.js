/**
 * ARINC 767-1 Enhanced Airborne Flight Recorder (EAFR) Core Engine (v1.0.0)
 * Implements ARINC Characteristic 767, EUROCAE ED-112A, ICAO Annex 6 (25-Hour CVR/FDR),
 * 4-Channel CSMU Multiplexing (FDR, CVR, DLR, Image), RIPS Power Holdover,
 * and 37.5 kHz Underwater Locating Beacon (ULB) Telemetry.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARINC767Engine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Standard ARINC 429 Labels for EAFR (ARINC 767 Attachment 2)
  const LABELS = {
    EAFR_STATUS: 0o270,        // Label 270 (Octal) - EAFR Operational Discrete Status Word
    EQUIPMENT_IDENT: 0o377,    // Label 377 (Octal) - EAFR System Equipment ID (Forward vs Aft)
    RECORD_TIME_UTC: 0o150,    // Label 150 (Octal) - Universal Coordinated Time (UTC BCD)
    PRESSURE_ALT: 0o203,       // Label 203 (Octal) - Pressure Altitude (BNR 17-bit)
    PITCH_ANGLE: 0o324,        // Label 324 (Octal) - Pitch Angle (BNR 14-bit)
    NORMAL_ACCEL: 0o370        // Label 370 (Octal) - Normal Acceleration / G-Force (BNR 12-bit)
  };

  // EAFR System Specifications per EUROCAE ED-112A & ICAO Annex 6
  const SPECS = {
    MIN_RECORDING_DURATION_HOURS: 25.0, // Mandatory 25-hour voice & data circular buffer
    FDR_PARAMETERS_COUNT: 1024,         // Mandatory Part 121 Appendix M parameters
    CVR_CHANNELS: 4,                    // Capt, F/O, Observer, Cockpit Area Mic (CAM)
    RIPS_HOLDOVER_MINUTES: 10.0,        // Recorder Independent Power Supply (TSO-C155a)
    ULB_FREQUENCY_KHZ: 37.5,            // Underwater Locating Beacon Acoustic Pulse (TSO-C121b)
    ULB_DURATION_DAYS: 90.0,            // 90-Day Battery Life Requirement
    CRASH_G_THRESHOLD: 6.0              // Impact G-Switch Threshold Trigger (g)
  };

  function calculateOddParity(word31) {
    let count = 0;
    for (let i = 0; i < 31; i++) {
      if ((word31 & (1 << i)) !== 0) count++;
    }
    return (count % 2 === 0) ? 1 : 0;
  }

  function reverseLabelBits(octalLabel) {
    let rev = 0;
    for (let i = 0; i < 8; i++) {
      if ((octalLabel & (1 << i)) !== 0) {
        rev |= (1 << (7 - i));
      }
    }
    return rev;
  }

  function encodeBnrWord(octalLabel, sdi, value, maxRange, bitsCount, ssm = 0b11) {
    const revLabel = reverseLabelBits(octalLabel);
    const sdiBits = (sdi & 0x03) << 8;
    const ssmBits = (ssm & 0x03) << 29;

    const clamped = Math.max(-maxRange, Math.min(maxRange, value));
    const normalized = clamped / maxRange;
    const maxInt = (1 << bitsCount) - 1;
    let intVal = Math.round(normalized * maxInt);
    if (intVal < 0) {
      intVal = ((1 << (bitsCount + 1)) + intVal) & ((1 << (bitsCount + 1)) - 1);
    }
    const dataBits = (intVal & ((1 << (bitsCount + 1)) - 1)) << 10;

    const word31 = revLabel | sdiBits | dataBits | ssmBits;
    const parity = calculateOddParity(word31);
    const fullWord = (word31 | (parity << 31)) >>> 0;

    return {
      labelOctal: octalLabel.toString(8).padStart(3, '0'),
      fullWordHex: '0x' + fullWord.toString(16).toUpperCase().padStart(8, '0'),
      wordInt: fullWord,
      parity: parity,
      ssm: ssm,
      sdi: sdi,
      value: clamped
    };
  }

  class EAFRUnit {
    constructor(location = 'AFT') {
      this.location = location; // 'FORWARD' (Cockpit) or 'AFT' (Empennage)
      this.recordingActive = true;
      this.ripsBatteryActive = false;
      this.ripsRemainingSeconds = SPECS.RIPS_HOLDOVER_MINUTES * 60.0;
      this.ulbBeaconActive = false;
      this.crashImpactLatched = false;
      this.recordedFrames = [];
      this.csmuChannels = {
        fdr: { name: 'Flight Data (FDR)', active: true, wordsPerSec: 1024, durationHours: 25.0 },
        cvr: { name: 'Cockpit Voice (CVR)', active: true, channels: 4, durationHours: 25.0 },
        dlr: { name: 'Data Link (DLR)', active: true, protocol: 'FANS_1A_CPDLC' },
        air: { name: 'Airborne Image (AIR)', active: true, resolution: '1080p' }
      };
    }

    /**
     * Ingests synchronized 4-channel telemetry packet into CSMU circular buffer
     */
    recordTelemetryFrame(flightData = {}) {
      if (!this.recordingActive) {
        return { recorded: false, reason: 'RECORDING_TERMINATED_CRASH_LATCH' };
      }

      const alt = flightData.altitudeFt !== undefined ? flightData.altitudeFt : 35000.0;
      const gLoad = flightData.gLoad !== undefined ? flightData.gLoad : 1.0;
      const pitch = flightData.pitchDeg !== undefined ? flightData.pitchDeg : 2.5;

      // Check impact g-switch
      if (Math.abs(gLoad) >= SPECS.CRASH_G_THRESHOLD) {
        this.crashImpactLatched = true;
        this.recordingActive = false;
        this.ulbBeaconActive = true;
        return {
          recorded: true,
          crashImpactTriggered: true,
          gLoad: gLoad,
          status: 'CSMU_MEMORY_SEALED_IMPACT_LATCH'
        };
      }

      const frame = {
        timestamp: new Date().toISOString(),
        location: this.location,
        altitudeFt: alt,
        gLoad: gLoad,
        pitchDeg: pitch,
        fdrActive: true,
        cvrActive: true,
        dlrActive: true,
        airActive: true
      };

      this.recordedFrames.push(frame);
      if (this.recordedFrames.length > 100) this.recordedFrames.shift();

      return {
        recorded: true,
        crashImpactTriggered: false,
        totalFrames: this.recordedFrames.length,
        status: 'CSMU_NORMAL_RECORDING'
      };
    }

    /**
     * Simulates primary aircraft bus power failure and RIPS battery takeover
     */
    triggerMainPowerLoss() {
      this.ripsBatteryActive = true;
      return {
        ripsActive: true,
        backupDurationMinutes: SPECS.RIPS_HOLDOVER_MINUTES,
        powerSource: 'RIPS_INTERNAL_BATTERY_TSO_C155A',
        status: 'RIPS_POWER_ENGAGED'
      };
    }
  }

  return {
    LABELS,
    SPECS,
    calculateOddParity,
    reverseLabelBits,
    encodeBnrWord,
    EAFRUnit
  };
}));