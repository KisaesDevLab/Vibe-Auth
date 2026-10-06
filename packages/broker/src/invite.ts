import type { Authentik } from "./authentik.js";
import { INVITE_TOKEN_DURATION, INVITE_VALID_FOR, type EmailConfig } from "./email.js";
import type { Logger } from "./log.js";

/**
 * Invitations: how a person the admin added gets their first password.
 *
 * A new user has no password. The invitation is a one-time link into the recovery flow (where
 * they choose one), emailed through the welcome stage and also handed to the admin to pass on
 * when mail is not set up or does not arrive. "Resend invite" repeats it for someone who has
 * never signed in; once they have, a forgotten password is a reset, not an invitation.
 *
 * authentik keeps one recovery token per user and every call re-uses it, setting its lifetime. So
 * the link is created first and the email sent last, both with INVITE_TOKEN_DURATION: the emailed
 * link and the admin's copy are the same token, valid for the full invitation period. (Sending the
 * email first used to let the admin-link call cut the emailed link back to 30 minutes.)
 */

export class InviteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface InviteResult {
  to: string;
  /** authentik accepted the email for delivery. */
  emailed: boolean;
  /** Why it was not emailed (no outbound mail, no address, stage missing, authentik refused). */
  emailError?: string;
  /** One-time set-password link for the admin to pass on; null when authentik refused it. */
  link: string | null;
  validFor: string;
}

type Ak = Pick<Authentik, "user" | "createRecoveryLink" | "sendRecoveryEmail">;
type Mail = Pick<EmailConfig, "status" | "welcomeStagePk">;

export class Invites {
  constructor(private ak: Ak, private email: Mail, private log: Logger) {}

  /**
   * Send (or re-send) the invitation. `resend` refuses a person who has already signed in or is
   * deactivated: re-inviting them would hand out a set-password link under the wrong label.
   */
  async send(pk: number, opts: { resend?: boolean } = {}): Promise<InviteResult> {
    const user = await this.ak.user(pk);
    const who = user.email || user.username;
    if (opts.resend) {
      if (user.last_login) throw new InviteError(409, `${who} has already signed in, so there is no invitation to resend. Use "Send reset email" if they have lost their password.`);
      if (!user.is_active) throw new InviteError(409, `${who} is deactivated. Activate them first, then resend the invitation.`);
    }

    const link = await this.ak.createRecoveryLink(pk, INVITE_TOKEN_DURATION).catch((e: Error) => {
      this.log.warn("invitation link not created", { user: pk, error: e.message });
      return null;
    });

    let emailed = false;
    let emailError: string | undefined;
    if (!user.email) {
      emailError = "the user has no email address";
    } else if (!(await this.email.status()).configured) {
      emailError = "no outbound email is configured (Admin → Email)";
    } else {
      const stagePk = await this.email.welcomeStagePk();
      if (!stagePk) {
        emailError = "the welcome email stage is not available yet (authentik blueprints still applying?)";
      } else {
        try {
          await this.ak.sendRecoveryEmail(pk, stagePk, INVITE_TOKEN_DURATION);
          emailed = true;
        } catch (e) {
          emailError = (e as Error).message;
        }
      }
    }
    if (emailError) this.log.warn("invitation email not sent", { user: pk, error: emailError });
    return { to: who, emailed, ...(emailError ? { emailError } : {}), link, validFor: INVITE_VALID_FOR };
  }
}
