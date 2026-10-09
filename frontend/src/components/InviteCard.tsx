import { useState } from "react";
import WebApp from "@twa-dev/sdk";

type Props = {
  refCode: string;
  referralCount: number;
  bonusPerInvite: number;
};

export default function InviteCard({ refCode, referralCount, bonusPerInvite }: Props) {
  const [copied, setCopied] = useState(false);

  // Бот-ссылка: /start?startapp=ref_<code> → попадает в initData.start_param
  const botUsername = "ErrorDrop_Bot";
  const inviteUrl = `https://t.me/${botUsername}?start=ref_${refCode}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      prompt("Ссылка приглашения:", inviteUrl);
    }
  };

  const share = () => {
    try {
      WebApp.openTelegramLink(inviteUrl);
    } catch {
      copy();
    }
  };

  return (
    <section className="invite-card">
      <div className="section-title" style={{ marginBottom: 0 }}>
        🤝 Пригласи друга
      </div>
      <div style={{ fontSize: 14 }}>
        Получай <b style={{ color: "var(--accent)" }}>{bonusPerInvite} ⭐</b> за каждые 100 ⭐ пополнения друга.
      </div>
      <div className="referral-note">
        Приглашено: {referralCount}
      </div>
      <div className="invite-code" style={{ marginTop: 4 }}>
        <button className="btn" onClick={copy} style={{ flex: 1 }}>
          {copied ? "✅ Скопировано" : "🔗 Скопировать ссылку"}
        </button>
        <button className="btn btn--ghost" onClick={share}>
          📨
        </button>
      </div>
    </section>
  );
}
