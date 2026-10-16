const enc = new TextEncoder()

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

/** Constant-time string compare: both sides are hashed to equal length first. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!
  return diff === 0
}

export async function isAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')
  if (!m) return false
  return safeEqual(m[1]!, token)
}
