// @ts-check
// The default browser comes from `npx playwright install chromium`.
// Override only when a test runner deliberately selects another executable.
/** @param {Record<string, string | undefined>} [env] */
export function browserLaunchOptions(env = process.env) {
  const executablePath = env.METRO_BROWSER_EXECUTABLE_PATH?.trim();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'],
  };
}
