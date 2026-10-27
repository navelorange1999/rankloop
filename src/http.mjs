import https from 'node:https';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { isPublicAddress, validatePath } from './policy.mjs';

// Fixed production origin. Fixture mode can only reach one explicit loopback port.
export function createRequester({ fixture = false } = {}) {
  const origin = fixture ? 'http://127.0.0.1:3000' : 'https://chankay.com';
  return async function request(path) {
    let url = new URL(path, origin);
    for (let hop = 0; hop <= 5; hop++) {
      if (url.origin !== origin || url.username || url.password || url.hash || url.search)
        throw Error('Unsafe request target');
      if (!['/robots.txt', '/sitemap.xml', '/api/seo/manifest'].includes(url.pathname))
        validatePath(url.pathname);
      let address;
      if (!fixture) {
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
          throw Error('Non-public DNS target');
        address = addresses[0];
      }
      const response = await new Promise((resolve, reject) => {
        const transport = fixture ? http : https;
        const req = transport.get(
          url,
          {
            agent: false,
            headers: {
              'User-Agent': 'Rankloop/0.1 (+https://github.com/navelorange1999/rankloop)',
              'Accept-Encoding': 'identity',
            },
            ...(address
              ? {
                  lookup: (_host, options, callback) =>
                    callback(null, options.all ? [address] : address.address, address.family),
                }
              : {}),
          },
          (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
              size += chunk.length;
              if (size > 2_000_000) {
                res.destroy();
                reject(Error('Response exceeds budget'));
              } else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(chunks).toString('utf8'),
                url: url.toString(),
                redirects: hop,
              }),
            );
          },
        );
        const timer = setTimeout(() => req.destroy(Error('Request timeout')), 20000);
        req.on('close', () => clearTimeout(timer));
        req.on('error', reject);
      });
      if (
        response.headers['content-encoding'] &&
        response.headers['content-encoding'] !== 'identity'
      )
        throw Error('Unexpected response encoding');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw Error('Invalid redirect');
        url = new URL(response.headers.location, url);
        continue;
      }
      return response;
    }
    throw Error('Redirect budget exceeded');
  };
}
