/**
 * Sowel Plugin: Panasonic Comfort Cloud
 *
 * Integrates Panasonic AC units via the Comfort Cloud API.
 * Uses a Python bridge (pcomfortcloud) for API communication.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ============================================================
// Local type definitions
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  trace(obj: Record<string, unknown>, msg: string): void;
  trace(msg: string): void;
}

interface EventBus { emit(event: unknown): void; }
interface SettingsManager { get(key: string): string | undefined; set(key: string, value: string): void; }

interface DiscoveredDevice {
  friendlyName: string; manufacturer?: string; model?: string;
  data: { key: string; type: string; category: string; unit?: string }[];
  orders: { key: string; type: string; dispatchConfig?: Record<string, unknown>; min?: number; max?: number; enumValues?: string[]; unit?: string }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(integrationId: string, sourceDeviceId: string, payload: Record<string, unknown>): void;
}

interface Device { id: string; integrationId: string; sourceDeviceId: string; name: string; }
interface PluginDeps { logger: Logger; eventBus: EventBus; settingsManager: SettingsManager; deviceManager: DeviceManager; pluginDir: string; }

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";
interface IntegrationSettingDef { key: string; label: string; type: "text" | "password" | "number" | "boolean"; required: boolean; placeholder?: string; defaultValue?: string; }

interface IntegrationPlugin {
  readonly id: string; readonly name: string; readonly description: string; readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus; isConfigured(): boolean; getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>; stop(): Promise<void>;
  executeOrder(device: Device, orderKeyOrDispatchConfig: string | Record<string, unknown>, value: unknown): Promise<void>;
  refresh?(): Promise<void>; getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

interface OrderMeta { guid: string; param: string }

// ============================================================
// Bridge types
// ============================================================

interface BridgeResponse { ok: boolean; error?: string }
interface BridgeLoginResponse extends BridgeResponse { ok: true; deviceCount: number }
interface BridgeDevicesResponse extends BridgeResponse { ok: true; devices: BridgeDevice[] }

interface BridgeDevice {
  id: string; name: string; group: string; model: string;
  parameters: {
    power: string | null; mode: string | null;
    targetTemperature: number | null; insideTemperature: number | null; outsideTemperature: number | null;
    fanSpeed: string | null; airSwingUD: string | null; airSwingLR: string | null;
    ecoMode: string | null; nanoe: string | null;
  };
  features: {
    nanoe?: boolean; autoMode?: boolean; heatMode?: boolean; dryMode?: boolean;
    coolMode?: boolean; fanMode?: boolean; airSwingLR?: boolean;
  };
}

// ============================================================
// Constants + enums
// ============================================================

const INTEGRATION_ID = "panasonic_cc";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;
const BRIDGE_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const ON_DEMAND_DELAY_MS = 10_000;

const FAN_SPEED_VALUES = ["auto", "low", "lowMid", "mid", "highMid", "high"];
const AIR_SWING_UD_VALUES = ["up", "down", "mid", "upMid", "downMid"];
const AIR_SWING_LR_VALUES = ["left", "right", "mid", "rightMid", "leftMid"];
const ECO_MODE_VALUES = ["auto", "powerful", "quiet"];
const NANOE_VALUES = ["unavailable", "off", "on", "modeG", "all"];

function getAvailableModes(features: BridgeDevice["features"]): string[] {
  const modes: string[] = [];
  if (features.autoMode !== false) modes.push("auto");
  if (features.dryMode !== false) modes.push("dry");
  if (features.coolMode !== false) modes.push("cool");
  if (features.heatMode !== false) modes.push("heat");
  if (features.fanMode !== false) modes.push("fan");
  return modes;
}

// ============================================================
// Python Bridge
// ============================================================

class PanasonicBridge {
  private pythonPath: string;
  private bridgePath: string;
  private tokenFile: string;
  private logger: Logger;

  constructor(tokenFile: string, bridgePath: string, pluginDir: string, logger: Logger) {
    this.tokenFile = tokenFile;
    this.bridgePath = bridgePath;
    this.logger = logger;

    // Auto-create venv in plugin directory if needed
    const venvDir = resolve(pluginDir, ".venv");
    const venvPython = resolve(venvDir, "bin", "python3");

    if (!existsSync(venvPython)) {
      logger.info("Creating Python venv for Panasonic CC bridge");
      try {
        execFileSync("python3", ["-m", "venv", venvDir], { timeout: 30_000 });
        const pip = resolve(venvDir, "bin", "pip");
        logger.info("Installing aio-panasonic-comfort-cloud");
        execFileSync(pip, ["install", "aio-panasonic-comfort-cloud==2025.1.2"], { timeout: 120_000 });
        logger.info("Python venv ready");
      } catch (err) {
        logger.error({ err } as Record<string, unknown>, "Failed to create Python venv");
      }
    }

    this.pythonPath = existsSync(venvPython) ? venvPython : "python3";
  }

  async login(email: string, password: string): Promise<void> {
    const result = await this.exec("login", email, password);
    if (!result.ok) throw new Error(`Login failed: ${result.error}`);
  }

  async getDevices(email: string, password: string): Promise<BridgeDevicesResponse> {
    const result = await this.exec("get_devices", email, password);
    if (!result.ok) throw new Error(`Get devices failed: ${result.error}`);
    return result as BridgeDevicesResponse;
  }

  async control(deviceId: string, param: string, value: unknown, email: string, password: string): Promise<void> {
    const result = await this.exec("control", email, password, ["--id", deviceId, "--param", param, "--value", String(value)]);
    if (!result.ok) throw new Error(`Control failed: ${result.error}`);
  }

  private exec(command: string, email: string, password: string, extraArgs: string[] = []): Promise<BridgeResponse> {
    const args = [this.bridgePath, command, "--email", email, "--password", password, "--token-file", this.tokenFile, ...extraArgs];
    this.logger.debug({ command, extraArgs }, "Executing Python bridge");

    return new Promise((resolve, reject) => {
      execFile(this.pythonPath, args, { timeout: BRIDGE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) { this.logger.error({ err: error, stderr } as Record<string, unknown>, "Bridge failed"); reject(new Error(`Bridge failed: ${error.message}`)); return; }
        if (stderr) this.logger.warn({ stderr: stderr.trim() } as Record<string, unknown>, "Bridge stderr");
        try { resolve(JSON.parse(stdout) as BridgeResponse); }
        catch { reject(new Error("Bridge returned invalid JSON")); }
      });
    });
  }
}

// ============================================================
// Plugin implementation
// ============================================================

class PanasonicCCPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Panasonic Comfort Cloud";
  readonly description = "Panasonic AC units via Comfort Cloud API";
  readonly icon = "AirVent";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private pluginDir: string;
  private bridge: PanasonicBridge | null = null;
  private status: IntegrationStatus = "disconnected";
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private lastPollAt: string | null = null;
  private polling = false;
  private pollFailed = false;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private email = "";
  private password = "";
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private orderMetaMap = new Map<string, OrderMeta>();

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
    this.pluginDir = deps.pluginDir;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.pollFailed) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("email") !== undefined && this.getSetting("password") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      { key: "email", label: "Panasonic ID (email)", type: "text", required: true, placeholder: "user@example.com" },
      { key: "password", label: "Password", type: "password", required: true },
      { key: "polling_interval", label: "Polling interval (seconds)", type: "number", required: false, defaultValue: "300", placeholder: "Min 60, default 300" },
    ];
  }

  async start(options?: { pollOffset?: number }): Promise<void> {
    this.stopPolling();
    this.bridge = null;
    if (!this.isConfigured()) { this.status = "not_configured"; return; }

    this.email = this.getSetting("email")!;
    this.password = this.getSetting("password")!;
    const pollingIntervalSec = parseInt(this.getSetting("polling_interval") ?? "300", 10);
    this.pollIntervalMs = (isNaN(pollingIntervalSec) ? 300 : Math.max(pollingIntervalSec, 60)) * 1000;

    // bridge.py is in the plugin directory (alongside dist/ and manifest.json)
    const bridgePath = resolve(this.pluginDir, "bridge.py");
    const dataDir = resolve(this.pluginDir, "..", "..", "data");
    const tokenFile = resolve(dataDir, "panasonic-tokens.json");

    try {
      this.bridge = new PanasonicBridge(tokenFile, bridgePath, this.pluginDir, this.logger);
      await this.bridge.login(this.email, this.password);
      this.logger.info("Panasonic CC credentials verified");

      await this.poll();

      const offset = options?.pollOffset ?? 0;
      const startInterval = () => { this.pollInterval = setInterval(() => this.safePoll(), this.pollIntervalMs); };
      if (offset > 0) { setTimeout(startInterval, offset); } else { startInterval(); }

      this.status = "connected";
      this.retryCount = 0;
      this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      this.logger.info({ pollIntervalMs: this.pollIntervalMs }, "Panasonic CC started");
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start Panasonic CC");
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.cancelRetry();
    this.stopPolling();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.bridge = null;
    this.status = "disconnected";
    this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
    this.logger.info("Panasonic CC stopped");
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.bridge || this.status !== "connected") throw new Error("Panasonic CC not connected");
    const meta = this.orderMetaMap.get(`${device.sourceDeviceId}:${orderKey}`);
    if (!meta) throw new Error(`Order metadata not found for ${device.sourceDeviceId}:${orderKey}`);

    await this.bridge.control(meta.guid, meta.param, value, this.email, this.password);
    this.logger.info({ guid: meta.guid, param: meta.param, value }, "Order executed");
    this.scheduleOnDemandPoll();
  }

  async refresh(): Promise<void> {
    if (!this.bridge || this.status !== "connected") throw new Error("Not connected");
    await this.poll();
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (!this.lastPollAt) return null;
    return { lastPollAt: this.lastPollAt, intervalMs: this.pollIntervalMs };
  }

  // ============================================================
  // Polling
  // ============================================================

  private async poll(): Promise<void> {
    if (this.polling || !this.bridge) return;
    this.polling = true;
    try {
      this.lastPollAt = new Date().toISOString();
      const response = await this.bridge.getDevices(this.email, this.password);

      for (const device of response.devices) {
        const { device: discovered, orderMetas } = mapDeviceToDiscovered(device);
        this.deviceManager.upsertFromDiscovery(INTEGRATION_ID, INTEGRATION_ID, discovered);
        for (const { key, meta } of orderMetas) {
          this.orderMetaMap.set(`${discovered.friendlyName}:${key}`, meta);
        }

        const sourceDeviceId = device.name || device.id;
        const p = device.parameters;
        const payload: Record<string, unknown> = {};
        if (p.power !== null) payload.power = p.power === "on";
        if (p.mode !== null) payload.operationMode = p.mode;
        if (p.targetTemperature !== null) payload.targetTemperature = p.targetTemperature;
        if (p.insideTemperature !== null) payload.insideTemperature = p.insideTemperature;
        if (p.outsideTemperature !== null) payload.outsideTemperature = p.outsideTemperature;
        if (p.fanSpeed !== null) payload.fanSpeed = p.fanSpeed;
        if (p.airSwingUD !== null) payload.airSwingUD = p.airSwingUD;
        if (p.airSwingLR !== null) payload.airSwingLR = p.airSwingLR;
        if (p.ecoMode !== null) payload.ecoMode = p.ecoMode;
        if (p.nanoe !== null) payload.nanoe = p.nanoe;
        this.deviceManager.updateDeviceData(INTEGRATION_ID, sourceDeviceId, payload);
      }

      if (this.pollFailed) {
        this.pollFailed = false;
        this.eventBus.emit({ type: "system.alarm.resolved", alarmId: `poll-fail:${INTEGRATION_ID}`, source: "Panasonic CC", message: "Communication rétablie" });
      }
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "Poll failed");
      if (!this.pollFailed) {
        this.pollFailed = true;
        this.eventBus.emit({ type: "system.alarm.raised", alarmId: `poll-fail:${INTEGRATION_ID}`, level: "error", source: "Panasonic CC", message: `Poll en échec : ${err instanceof Error ? err.message : String(err)}` });
      }
    } finally { this.polling = false; }
  }

  private safePoll(): void { this.poll().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Poll failed")); }

  private scheduleOnDemandPoll(): void {
    const timer = setTimeout(() => { this.pendingTimers.delete(timer); this.safePoll(); }, ON_DEMAND_DELAY_MS);
    this.pendingTimers.add(timer);
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    this.retryCount++;
    const delaySec = Math.min(30 * Math.pow(2, this.retryCount - 1), 600);
    this.logger.warn({ retryCount: this.retryCount, delaySec }, "Scheduling retry");
    this.retryTimeout = setTimeout(() => { this.retryTimeout = null; this.start().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Retry failed")); }, delaySec * 1000);
  }

  private cancelRetry(): void { if (this.retryTimeout) { clearTimeout(this.retryTimeout); this.retryTimeout = null; } }
  private stopPolling(): void { if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; } }
  private getSetting(key: string): string | undefined { return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`); }
}

// ============================================================
// Device mapping
// ============================================================

function mapDeviceToDiscovered(device: BridgeDevice): { device: DiscoveredDevice; orderMetas: { key: string; meta: OrderMeta }[] } {
  const features = device.features;
  const data: DiscoveredDevice["data"] = [
    { key: "power", type: "boolean", category: "power" },
    { key: "operationMode", type: "enum", category: "generic" },
    { key: "targetTemperature", type: "number", category: "setpoint", unit: "°C" },
    { key: "insideTemperature", type: "number", category: "temperature", unit: "°C" },
    { key: "outsideTemperature", type: "number", category: "temperature_outdoor", unit: "°C" },
    { key: "fanSpeed", type: "enum", category: "generic" },
    { key: "airSwingUD", type: "enum", category: "generic" },
    { key: "airSwingLR", type: "enum", category: "generic" },
    { key: "ecoMode", type: "enum", category: "generic" },
  ];
  if (features.nanoe) data.push({ key: "nanoe", type: "enum", category: "generic" });

  const orders: DiscoveredDevice["orders"] = [
    { key: "power", type: "boolean" },
    { key: "operationMode", type: "enum", enumValues: getAvailableModes(features) },
    { key: "targetTemperature", type: "number", min: 16, max: 30, unit: "°C" },
    { key: "fanSpeed", type: "enum", enumValues: [...FAN_SPEED_VALUES] },
    { key: "airSwingUD", type: "enum", enumValues: [...AIR_SWING_UD_VALUES] },
  ];
  const orderMetas: { key: string; meta: OrderMeta }[] = [
    { key: "power", meta: { guid: device.id, param: "power" } },
    { key: "operationMode", meta: { guid: device.id, param: "mode" } },
    { key: "targetTemperature", meta: { guid: device.id, param: "targetTemperature" } },
    { key: "fanSpeed", meta: { guid: device.id, param: "fanSpeed" } },
    { key: "airSwingUD", meta: { guid: device.id, param: "airSwingUD" } },
  ];
  if (features.airSwingLR) {
    orders.push({ key: "airSwingLR", type: "enum", enumValues: [...AIR_SWING_LR_VALUES] });
    orderMetas.push({ key: "airSwingLR", meta: { guid: device.id, param: "airSwingLR" } });
  }
  orders.push({ key: "ecoMode", type: "enum", enumValues: [...ECO_MODE_VALUES] });
  orderMetas.push({ key: "ecoMode", meta: { guid: device.id, param: "ecoMode" } });
  if (features.nanoe) {
    orders.push({ key: "nanoe", type: "enum", enumValues: [...NANOE_VALUES] });
    orderMetas.push({ key: "nanoe", meta: { guid: device.id, param: "nanoe" } });
  }

  const friendlyName = device.name || device.id;
  return {
    device: { friendlyName, manufacturer: "Panasonic", model: device.model || undefined, data, orders },
    orderMetas,
  };
}

// ============================================================
// Plugin entry point
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new PanasonicCCPlugin(deps);
}
