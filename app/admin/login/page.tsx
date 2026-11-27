'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import styles from '../admin.module.css';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password })
      });
      const data = await response.json() as { error?: string; authenticated?: boolean };
      if (!response.ok || !data.authenticated) throw new Error(data.error || 'تعذر تسجيل الدخول.');
      router.replace('/admin');
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تسجيل الدخول.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles['admin-login-page']}>
      <section className={styles['admin-login-card']}>
        <div className={styles['admin-login-brand']}>
          <div className={styles['admin-brand-mark']}>أ</div>
          <div><strong>أرض الجوال</strong><small>لوحة الإدارة المركزية</small></div>
        </div>
        <h1>تسجيل دخول الإدارة</h1>
        <p className={styles['admin-login-subtitle']}>ادخل بحساب الإدارة للوصول إلى المنتجات والطلبات والإعدادات والاستيراد.</p>
        <form onSubmit={submit}>
          <div className={styles['admin-form-field']}>
            <label htmlFor="admin-email">البريد الإلكتروني</label>
            <input id="admin-email" className={styles['admin-input']} type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" />
          </div>
          <div className={styles['admin-form-field']}>
            <label htmlFor="admin-password">كلمة المرور</label>
            <input id="admin-password" className={styles['admin-input']} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="أدخل كلمة المرور" />
          </div>
          {error ? <div className={styles['admin-error']} role="alert">{error}</div> : null}
          <button className={styles['admin-primary-button'] + ' ' + styles['admin-full-button']} disabled={busy} type="submit">{busy ? 'جارٍ التحقق...' : 'دخول لوحة الإدارة'}</button>
        </form>
        <div className={styles['admin-login-footer']}><Link href="/">العودة إلى المتجر</Link></div>
      </section>
    </main>
  );
}
