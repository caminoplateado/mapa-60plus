export async function onRequestGet(context) {
  const token = (context?.env && context.env.MAPBOX_TOKEN) ? String(context.env.MAPBOX_TOKEN) : "";
  const body = `window.MAPBOX_TOKEN=${JSON.stringify(token)};`;
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
