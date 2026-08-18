/**
 * Sign in or sign up — the same component behaviour as MyStokio's own login screen.
 *
 * Same account, same backend, so the form matches `MyStokio/src/pages/Login.tsx` field for
 * field and rule for rule:
 *
 *   Login mode   A free-text **User ID**, and no validation at all. Whatever is typed is
 *                sent as-is. MyStokio's `validate()` only runs its checks in signup mode,
 *                so an identifier there need not be an email — it can be a phone number,
 *                a shop code, a name, anything the backend recognises. Imposing email
 *                format here would lock people out of accounts that work in MyStokio.
 *
 *   Signup mode  Name, email, password, optional phone and shop name — plus the access
 *                key. Only non-emptiness is checked, exactly as MyStokio checks it: no
 *                email pattern, no password length. The backend is the authority on
 *                whether a credential is acceptable, and it says so through
 *                VALIDATION_FAILED.
 *
 * ── Two things deliberately not copied ──────────────────────────────────────
 * MyStokio offers "continue as guest", which drops into offline mode against a local Excel
 * file. There is nothing to be a guest of here: a scan session belongs to a user and is
 * read back by that user at the counter, so an anonymous session could be listed and
 * billed by a stranger pointed at the same server.
 *
 * And MyStokio's `loginRequest` substitutes a hard-coded "demo-token" when the backend is
 * unreachable, so any credentials appear to work offline. Copying that here would produce
 * an app that looks signed in and then fails every single action, because every action
 * needs the server. A failed sign-in fails, and says why.
 *
 * ── No address field ────────────────────────────────────────────────────────
 * The backend is compiled in — see lib/config.ts, where one `ENV` constant chooses between
 * the dev and prod bases. Nothing here can change it. That is the point: a host typed into
 * a phone but not into the counter, or the other way round, produces two apps that each
 * work perfectly and cannot see each other's scans, and the symptom ("no scans waiting")
 * gives no hint of the cause.
 */

import {
  AlertTriangle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ScanBarcode,
} from "lucide-react";
import { useState } from "react";
import { SIGNUP_ACCESS_KEY } from "../lib/access";
import { DEFAULT_PLAN, PLANS } from "../lib/config";
import { type User, login, register } from "../lib/api";

type Mode = "login" | "signup";

interface Form {
  name: string;
  email: string;
  password: string;
  phone: string;
  shopName: string;
  developerCode: string;
}

const EMPTY: Form = {
  name: "",
  email: "",
  password: "",
  phone: "",
  shopName: "",
  developerCode: "",
};

export function LoginScreen({
  onSignedIn,
}: {
  onSignedIn: (user: User) => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [form, setForm] = useState<Form>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  /* Mandatory on the server, so it is a real field here rather than a hidden default. */
  const [plan, setPlan] = useState(DEFAULT_PLAN);
  const [accessKey, setAccessKey] = useState("");
  const [showAccessKey, setShowAccessKey] = useState(false);

  const set =
    (key: keyof Form) => (event: React.ChangeEvent<HTMLInputElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
      if (fieldErrors[key])
        setFieldErrors((current) => ({ ...current, [key]: "" }));
      if (error) setError("");
    };

  /**
   * MyStokio's rules, unchanged.
   *
   * Note what is *not* here: login mode is not validated at all, and even in signup mode
   * the email is only checked for emptiness. That is not an oversight being copied — it is
   * what lets a user ID be any string the backend accepts.
   */
  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (mode === "signup") {
      /* MyStokio's rules exactly: non-emptiness, nothing more. The server is the authority on
         whether a credential is acceptable and reports it through a validation error. */
      if (form.name.trim().length < 1) errors.name = "Enter your name.";
      if (form.email.trim().length === 0) errors.email = "Email is required.";
      if (form.password.length === 0) errors.password = "Password is required.";
      /* Registration is invite-only, as it is in MyStokio. */
      if (accessKey !== SIGNUP_ACCESS_KEY)
        errors.accessKey = "Incorrect access key.";
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) return;

    setBusy(true);
    setError("");
    try {
      const user =
        mode === "login"
          ? await login(form.email.trim(), form.password)
          : await register({
              name: form.name.trim(),
              email: form.email.trim(),
              password: form.password,
              phone: form.phone.trim() || undefined,
              shopName: form.shopName.trim() || undefined,
              developerCode: accessKey.trim(),
              plan,
            });
      onSignedIn(user);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof Form,
    label: string,
    options: {
      type?: string;
      autoComplete?: string;
      inputMode?: "email" | "tel" | "text";
      placeholder?: string;
      hint?: string;
    } = {},
  ) => (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold text-white/70">
        {label}
      </span>
      <input
        type={options.type ?? "text"}
        value={form[key]}
        onChange={set(key)}
        className="field"
        autoComplete={options.autoComplete}
        inputMode={options.inputMode}
        placeholder={options.placeholder}
        aria-invalid={Boolean(fieldErrors[key])}
      />
      {fieldErrors[key] ? (
        <span className="mt-1 block text-[12px] font-semibold text-rose-400">
          {fieldErrors[key]}
        </span>
      ) : options.hint ? (
        <span className="mt-1 block text-[12px] text-white/40">
          {options.hint}
        </span>
      ) : null}
    </label>
  );

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
          Scan barcodes here, bill them on your PC in MyStokio.
        </p>
      </div>

      <form onSubmit={submit} className="card space-y-3">
        <div className="flex rounded-xl bg-black/25 p-1 text-sm font-semibold">
          {(["login", "signup"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setMode(option);
                setError("");
                setFieldErrors({});
              }}
              className={`flex-1 rounded-lg py-2 transition-colors ${
                mode === option
                  ? "bg-brand-500 text-white"
                  : "text-white/60 hover:text-white"
              }`}
            >
              {option === "login" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <p className="text-[12.5px] leading-relaxed text-white/45">
          {mode === "login"
            ? "The same email and password you use in MyStokio."
            : "This creates one account for both MyStokio and MyCodeScan. You will be signed in straight away."}
        </p>

        {mode === "signup" &&
          field("name", "Your name", { autoComplete: "name" })}

        {/* Accounts are identified by email on these routes. */}
        {field("email", "Email", {
          type: "email",
          autoComplete: "email",
          inputMode: "email",
          placeholder: "you@shop.in",
        })}

        <label className="block">
          <span className="mb-1 block text-[13px] font-semibold text-white/70">
            Password
          </span>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={form.password}
              onChange={set("password")}
              className="field pr-11"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              placeholder="••••••••"
              aria-invalid={Boolean(fieldErrors.password)}
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
          {fieldErrors.password && (
            <span className="mt-1 block text-[12px] font-semibold text-rose-400">
              {fieldErrors.password}
            </span>
          )}
        </label>

        {mode === "signup" && (
          <>
            {field("name", "Your name", {
              autoComplete: "name",
            })}

            {field("phone", "Phone (optional)", {
              autoComplete: "tel",
              inputMode: "tel",
            })}
            {field("shopName", "Shop name (optional)", {
              autoComplete: "organization",
            })}

            {field("developerCode", "Developer Code", {
              type: "text",
              autoComplete: "off",
              inputMode: "text",
              placeholder: "Enter developer code",
              hint: "Required to create an account.",
            })}
            {/*
              The subscription. Mandatory, so it is asked for rather than assumed — this is what
              decides when the account stops working, and the person creating it should see it.
              Only the plan is chosen; the dates are computed by the server and never sent.
            */}
            <fieldset>
              <legend className="mb-1 block text-[13px] font-semibold text-white/70">
                Subscription
              </legend>
              <div className="grid gap-1.5">
                {PLANS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors ${
                      plan === option.value
                        ? "border-brand-400 bg-brand-500/10"
                        : "border-white/15 bg-white/[0.04] hover:border-white/25"
                    }`}
                  >
                    <input
                      type="radio"
                      name="plan"
                      value={option.value}
                      checked={plan === option.value}
                      onChange={() => setPlan(option.value)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-semibold">
                        {option.label}
                      </span>
                      <span className="block text-[12px] text-white/45">
                        {option.note}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Invite-only, matching MyStokio. */}
            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-white/70">
                <KeyRound className="h-3.5 w-3.5" />
                Access key
              </span>
              <div className="relative">
                <input
                  type={showAccessKey ? "text" : "password"}
                  value={accessKey}
                  onChange={(event) => {
                    setAccessKey(event.target.value);
                    if (fieldErrors.accessKey)
                      setFieldErrors((current) => ({
                        ...current,
                        accessKey: "",
                      }));
                  }}
                  className="field pr-11"
                  autoComplete="off"
                  placeholder="Provided by the developer"
                  aria-invalid={Boolean(fieldErrors.accessKey)}
                />
                <button
                  type="button"
                  onClick={() => setShowAccessKey((value) => !value)}
                  aria-label={
                    showAccessKey ? "Hide access key" : "Show access key"
                  }
                  className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white/80"
                >
                  {showAccessKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {fieldErrors.accessKey ? (
                <span className="mt-1 block text-[12px] font-semibold text-rose-400">
                  {fieldErrors.accessKey}
                </span>
              ) : (
                <span className="mt-1 block text-[12px] text-white/40">
                  Registration is invite-only, as it is in MyStokio.
                </span>
              )}
            </label>
          </>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[13px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
