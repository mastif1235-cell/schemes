/* Блокнот-скан v3 additive loader. Keeps the stable v2 bundle untouched. */
(async () => {
  try {
    const response = await fetch('./v3-enhancements.txt', { cache: 'no-store' });
    if (!response.ok) throw new Error(`v3-enhancements.txt: HTTP ${response.status}`);
    const b64 = (await response.text()).trim();
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const js = await new Response(stream).text();
    const script = document.createElement('script');
    script.textContent = js;
    document.body.appendChild(script);
  } catch (err) {
    console.error('Блокнот-скан v3: дополнения не загрузились, остаётся стабильная v2', err);
  }
})();
