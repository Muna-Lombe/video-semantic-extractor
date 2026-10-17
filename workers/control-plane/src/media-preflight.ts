/** @type implementation @purpose Bound public media-link checks without downloading videos in the Worker. */
export function publicMediaUrl(value: string): URL {
  const url = new URL(value), host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new Error('Use a public HTTPS hostname without credentials, a fragment or a custom port.');
  return url;
}
export async function probeMedia(urls: string[], fetcher: typeof fetch = fetch) {
  if (urls.length < 1 || urls.length > 25) throw new Error('Check 1–25 links at a time.');
  const results = [];
  for (let start = 0; start < urls.length; start += 5) {
    results.push(...await Promise.all(urls.slice(start, start + 5).map(async (value) => {
      try {
        let url = publicMediaUrl(value);
        for (let attempt = 0; attempt < 4; attempt++) {
          const response = await fetcher(url.toString(), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
          if ([301,302,303,307,308].includes(response.status)) {
            const target = response.headers.get('location');
            if (!target || attempt === 3) throw new Error('Redirect chain is missing a target or too long.');
            url = publicMediaUrl(new URL(target, url).toString()); continue;
          }
          const type = response.headers.get('content-type')?.split(';')[0] || null;
          return { url: value, final_url: url.toString(), status: response.status, reachable: response.ok, media_type: type, size_bytes: response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null, media_type_supported: Boolean(type?.startsWith('video/') || type === 'application/octet-stream'), note: 'Header check only; decoding and content checksums are verified during sampling.' };
        }
        throw new Error('No final response.');
      } catch (cause) { return { url: value, reachable: false, error: (cause as Error).message }; }
    })));
  }
  return results;
}
