import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class MProxyClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.token = token || '';
    if (!this.baseUrl) {
      logger.warn('MProxy base URL is not set; MTProto features are disabled');
    }
  }

  isEnabled() {
    return Boolean(this.baseUrl && this.token);
  }

  async fetchMembers(channelIdOrUsername, { limit = 1000, offset = 0 } = {}) {
    if (!this.isEnabled()) {
      throw new Error('MProxy is not configured');
    }
    const url = `${this.baseUrl}/channels/${encodeURIComponent(channelIdOrUsername)}/members?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MProxy error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async fetchAllMembers(channelIdOrUsername, { pageSize = 200, hardMax = 20000 } = {}) {
    if (!this.isEnabled()) {
      throw new Error('MProxy is not configured');
    }
    const members = [];
    let offset = 0;
    while (true) {
      const page = await this.fetchMembers(channelIdOrUsername, { limit: pageSize, offset });
      if (!Array.isArray(page) || page.length === 0) break;
      members.push(...page);
      offset += page.length;
      if (members.length >= hardMax) break;
    }
    return members;
  }


  async fetchAdmins(channelIdOrUsername, { limit = 10000, offset = 0 } = {}) {
    if (!this.isEnabled()) {
      throw new Error('MProxy is not configured');
    }
    const url = `${this.baseUrl}/channels/${encodeURIComponent(channelIdOrUsername)}/members?role=admins&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MProxy error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async joinTarget(target) {
    if (!this.isEnabled()) {
      throw new Error('MProxy is not configured');
    }
    const url = `${this.baseUrl}/join`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MProxy join error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async sendMessages(userIds, text) {
    if (!this.isEnabled()) {
      throw new Error('MProxy is not configured');
    }
    const url = `${this.baseUrl}/sendMessages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_ids: userIds, text }),
    });
    if (!res.ok) {
      const textRes = await res.text().catch(() => '');
      throw new Error(`MProxy sendMessages error ${res.status}: ${textRes}`);
    }
    return res.json();
  }

  async me() {
    const res = await fetch(`${this.baseUrl}/me`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`MProxy /me error ${res.status}`);
    return res.json();
  }

  async isMember(target) {
    const res = await fetch(`${this.baseUrl}/channels/${encodeURIComponent(target)}/isMember`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`MProxy isMember error ${res.status}`);
    return res.json();
  }
}

export function buildMProxyFromEnv() {
  const baseUrl = (process.env.MPROXY_BASE_URL || '').trim();
  const token = (process.env.MPROXY_TOKEN || '').trim();
  return new MProxyClient({ baseUrl, token });
}


