export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function formatUserLink(user) {
  const id = escapeHtml(user.user_id);
  const nameTextRaw = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const hasName = Boolean(nameTextRaw);
  const nameText = hasName ? escapeHtml(nameTextRaw) : '';
  if (user.username) {
    const uname = escapeHtml(user.username);
    return `<a href="https://t.me/${uname}">@${uname}</a>`;
  }
  const nameSuffix = hasName ? ` (${nameText})` : '';
  return `<a href="tg://user?id=${id}">id:${id}</a>${nameSuffix}`;
}

export async function sendChunkedHtml(ctx, lines, maxLen = 3500) {
  const chunks = [];
  let current = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > maxLen) {
      chunks.push(current.join('\n'));
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.replyWithHTML(chunk, { disable_web_page_preview: true });
  }
}

export function normalizeUsername(u) {
  return String(u || '').replace(/^@/, '').toLowerCase();
}

export function buildExcludedUsernamesFromEnv(envValue) {
  return new Set(
    String(envValue || 'unknownUniverseHere')
      .split(',')
      .map((s) => normalizeUsername(s))
      .filter(Boolean)
  );
}

export async function filterEligibleMembers({ mproxy, channel, members, excludedUsernames }) {
  const [admins, clientMe] = await Promise.all([
    mproxy.fetchAdmins(channel).catch(() => []),
    mproxy.me().catch(() => null),
  ]);
  const adminIds = new Set(admins.map((u) => String(u.user_id)));
  const clientId = clientMe ? String(clientMe.user_id || clientMe.id) : null;
  return members.filter((m) => {
    const idStr = String(m.user_id);
    const uname = normalizeUsername(m.username);
    if (m.is_bot) return false;
    if (excludedUsernames.has(uname)) return false;
    if (adminIds.has(idStr)) return false;
    if (clientId && idStr === clientId) return false;
    return true;
  });
}


