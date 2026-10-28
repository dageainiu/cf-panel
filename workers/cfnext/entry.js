export default {
  async fetch(req, env, ctx) {
    const m = await import('./worker.js');
    return m.default.fetch(req, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const m = await import('./worker.js');
    if (m.default.scheduled) return m.default.scheduled(controller, env, ctx);
  }
};
