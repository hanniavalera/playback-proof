// Secrets for the tests, made of pieces at run time: no line of this repository holds a whole key, so that a secret scanner reading the
// source finds nothing to report, and the tests still plant text that has exactly the shape of the real thing. None of them is a real
// credential of anyone.

const join = (...pieces: string[]): string => pieces.join('');

/** One sample of every pattern of `SECRET_PATTERNS` (triage/redact.ts), by the name of the pattern. */
export const SECRETS: Record<string, string> = {
  'private-key': join(
    '-----BEGIN ',
    'RSA PRIVATE',
    ' KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END ',
    'RSA PRIVATE',
    ' KEY-----',
  ),
  'anthropic-api-key': join('sk-', 'ant-', 'api03-', 'ZZtestZZtestZZtestZZtest0123456789abcd'),
  'api-key': join('sk-', 'proj-', 'ZZtestZZtestZZtestZZtest0123456789'),
  'github-token': join('gh', 'p_', 'ZZtestZZtestZZtestZZtestZZtest012345'),
  'aws-access-key-id': join('AK', 'IA', 'ZZTESTZZTESTZZTE'),
  'google-api-key': join('AI', 'za', 'ZZtestZZtestZZtestZZtestZZtest012345'),
  'slack-token': join('xo', 'xb-', '0123456789-ZZtestZZtest'),
  'payment-key': join('sk_', 'live_', 'ZZtestZZtestZZtest0123'),
  'npm-token': join('npm', '_', 'ZZtestZZtestZZtestZZtestZZtest0123456'),
  jwt: join('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJ0ZXN0In0', '.', 'c2lnbmF0dXJlc2lnbmF0dXJl'),
  'bearer-token': join('Bea', 'rer ', 'ZZtestZZtestZZtestZZtest0123456789'),
  'basic-credentials': join('Bas', 'ic ', 'dGVzdHVzZXI6dGVzdHBhc3N3b3Jk'),
  'url-credentials': join('post', 'gres://', 'svc_user', ':', 'hunter2hunter2', '@db.internal/pb'),
  'secret-assignment': join('DB_PASS', 'WORD', '=', 'correct-horse-battery'),
  'long-hex': join('9b74c9897bac770ffc029102a200c5de', '0cc175b9c0f1b6a831c399e269772661'),
};

/** The key of a run of the summarizer: the shape of an Anthropic API key, and not a key. */
export const FAKE_API_KEY = join('sk-', 'ant-', 'api03-', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789');
