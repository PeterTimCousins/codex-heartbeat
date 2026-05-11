import { appendLine } from './fs-util.mjs';

export class AppServerClient {
  constructor(url, logFile = null) {
    this.url = url;
    this.logFile = logFile;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closedByClient = false;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (event) => this.handleMessage(event.data));
    this.ws.addEventListener('close', (event) => this.handleClose(event));
    this.ws.addEventListener('error', (event) => this.handleError(event));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  async initialize(name = 'codex-heartbeat') {
    return this.request('initialize', {
      clientInfo: { name, version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot send ${method}; app-server WebSocket is not open.`);
    }
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, method, timeout });
    });
  }

  close() {
    if (this.ws) {
      this.closedByClient = true;
      this.ws.close();
    }
  }

  emit(method, params) {
    const handlers = this.handlers.get(method) ?? [];
    for (const handler of handlers) {
      handler(params);
    }
  }

  rejectPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  handleClose(event) {
    const reason = event?.reason ? ` reason=${event.reason}` : '';
    const message = `App-server WebSocket closed code=${event?.code ?? 'unknown'}${reason}`;
    if (this.logFile) {
      appendLine(this.logFile, message);
    }
    this.rejectPending(new Error(message));
    if (!this.closedByClient) {
      this.emit('websocket/closed', { code: event?.code ?? null, reason: event?.reason ?? null });
    }
  }

  handleError(event) {
    const message = event?.message ?? 'unknown WebSocket error';
    if (this.logFile) {
      appendLine(this.logFile, `App-server WebSocket error: ${message}`);
    }
    this.emit('websocket/error', { message });
  }

  handleMessage(data) {
    const text = String(data);
    if (this.logFile) {
      appendLine(this.logFile, `recv ${text}`);
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.emit(message.method, message.params);
  }
}
