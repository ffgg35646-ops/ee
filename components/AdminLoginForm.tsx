'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import styles from './AdminDashboard.module.css';

export default function AdminLoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setMissing([]);
    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || 'تعذر تسجيل الدخول.');
        setMissing(Array.isArray(result.missing) ? result.missing : []);
        return;
      }
      router.replace('/admin');
      router.refresh();
    } catch {
      setError('تعذر الاتصال بالخادم. حاول مرة أخرى.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.loginPage}>
      <form className={styles.loginCard} onSubmit={submit}>
        <div className={styles.loginMark}>أ</div>
        <span className={styles.loginEyebrow}>أرض الجوال</span>
        <h1>لوحة إدارة المتجر</h1>
        <p>سجّل الدخول لإدارة المنتجات والطلبات ومحتوى المتجر.</p>
        {error && <div className={styles.errorBox}>{error}</div>}
        {missing.length > 0 && (
          <div className={styles.setupBox}>
            <strong>متغيرات البيئة المطلوبة:</strong>
            {missing.map((item) => <code key={item}>{item}</code>)}
          </div>
        )}
        <label>اسم المستخدم</label>
        <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        <label>كلمة المرور</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <button className={styles.primaryButton} disabled={loading}>{loading ? 'جارٍ التحقق...' : 'تسجيل الدخول'}</button>
        <small>الدخول مخصص لحسابات الإدارة فقط.</small>
      </form>
    </main>
  );
}
