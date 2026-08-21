/**
 * Sign in. There is no sign-up.
 *
 * Accounts are MyStockio's, and this app deliberately no longer creates them. Registration is
 * the one action here that writes something permanent and shared: an account made in MyCodeScan
 * signs in to MyStockio too, on the same subscription, and a shop's staff standing at a shelf
 * with a phone are not the people who should be opening it. So the form does one thing, and the
 * account comes from MyStockio.
 *
 * `register()` and `SignupInput` remain in lib/api.ts on purpose — they are part of the documented
 * client surface for those routes, and deleting them would put the client out of step with
 * API-CONTRACT.md over a decision about which screens this app happens to show.
 *
 * ── No validation on the way out ────────────────────────────────────────────
 * Whatever is typed is sent as-is, matching MyStockio's own `validate()`, which runs no checks
 * in login mode. An identifier there need not be an email — it can be a phone number, a shop
 * code, a name, anything the backend recognises. Imposing an email pattern here would lock
 * people out of accounts that work perfectly in MyStockio.
 *
 * ── Two things deliberately not copied ──────────────────────────────────────
 * MyStockio offers "continue as guest", which drops into offline mode against a local Excel
 * file. There is nothing to be a guest of here: a scan session belongs to a user and is read
 * back by that user at the counter, so an anonymous session could be listed and billed by a
 * stranger pointed at the same server.
 *
 * And MyStockio's `loginRequest` substitutes a hard-coded "demo-token" when the backend is
 * unreachable, so any credentials appear to work offline. Copying that here would produce an app
 * that looks signed in and then fails every single action, because every action needs the server.
 * A failed sign-in fails, and says why.
 *
 * ── No address field ────────────────────────────────────────────────────────
 * The backend is compiled in — see lib/config.ts, where one `ENV` constant chooses between the
 * dev and prod bases. Nothing here can change it. That is the point: a host typed into a phone
 * but not into the counter, or the other way round, produces two apps that each work perfectly
 * and cannot see each other's scans, and the symptom ("no scans waiting") gives no hint of the
 * cause.
 */

import { AlertTriangle, Eye, EyeOff, Loader2, ScanBarcode } from "lucide-react";
import { useState } from "react";
import { type User, login } from "../lib/api";

export function LoginScreen({
  onSignedIn,
}: {
  onSignedIn: (user: User) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSignedIn(await login(email.trim(), password));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-7 text-center">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-2xl"
          style={{ background: "rgba(115,66,226,0.18)" }}
        >
          <ScanBarcode className="h-7 w-7 text-brand-400" />
        </span>
        <h1 className="mt-3 text-2xl font-bold">MyCodeScan</h1>
        <p className="mt-1 text-sm text-white/55">
          Scan barcodes here, bill them on your PC in MyStockio.
        </p>
      </div>

      <form onSubmit={submit} className="card space-y-3">
        <p className="text-[12.5px] leading-relaxed text-white/45">
          The same email and password you use in MyStockio.
        </p>

        <label className="block">
          <span className="mb-1 block text-[13px] font-semibold text-white/70">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (error) setError("");
            }}
            className="field"
            autoComplete="email"
            inputMode="email"
            placeholder="you@shop.in"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] font-semibold text-white/70">
            Password
          </span>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) setError("");
              }}
              className="field pr-11"
              autoComplete="current-password"
              placeholder="••••••••"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white/80"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </label>

        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[13px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Sign in
        </button>

        <p className="text-center text-[12px] leading-relaxed text-white/35">
          Accounts are created in MyStockio. Ask whoever set the shop up if you need one.
        </p>
      </form>
    </div>
  );
}
