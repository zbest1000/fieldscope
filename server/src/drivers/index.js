// Driver registry (§3, plugin boundary). Loads every driver, validates its
// manifest against the contract, and exposes the capability manifests that drive
// the UI. Adding a protocol means dropping a driver file in here — nothing in
// the UI, evidence, or rules layers changes.

import { normalizeManifest } from '../contract/contract.js';
import * as icmp from './icmp.js';
import * as tcpudp from './tcpudp.js';
import * as dns from './dns.js';
import * as tls from './tls.js';
import * as modbus from './modbus.js';

const MODULES = [icmp, tcpudp, dns, tls, modbus];

export class DriverRegistry {
  constructor() {
    this.drivers = new Map();
    for (const mod of MODULES) this.register(mod);
  }

  register(mod) {
    const manifest = normalizeManifest(mod.manifest);
    this.drivers.set(manifest.id, { manifest, verbs: mod.verbs });
  }

  get(id) {
    return this.drivers.get(id);
  }

  manifest(id) {
    const d = this.drivers.get(id);
    return d ? d.manifest : null;
  }

  list() {
    return [...this.drivers.values()].map((d) => d.manifest);
  }

  // Grouped for the left-rail workspace navigation (§7).
  grouped() {
    const groups = {};
    for (const d of this.drivers.values()) {
      const g = d.manifest.group || d.manifest.domain;
      (groups[g] ||= []).push(d.manifest);
    }
    return groups;
  }
}
