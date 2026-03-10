export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Proxy /:id or /:id.ext to the API worker's /image/:id route
    if (url.pathname.match(/^\/[a-zA-Z0-9_-]{21}(?:\.[a-zA-Z]+)?$/)) {
      return fetch(`https://api.imagehost.ing/image${url.pathname}`, request);
    }

    // Everything else — serve the static Pages site
    return env.ASSETS.fetch(request);
  },
};
