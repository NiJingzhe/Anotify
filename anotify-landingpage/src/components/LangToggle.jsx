import { useI18n } from '../i18n.js';

// 语言切换：按钮显示「另一种语言」，样式沿用 ThemeToggle（icon-btn）
export default function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <button
      type="button"
      className="icon-btn lang-toggle"
      onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
      aria-label={t('lang.aria')}
      title={t('lang.title')}
    >
      <span aria-hidden="true">{t('lang.label')}</span>
    </button>
  );
}
