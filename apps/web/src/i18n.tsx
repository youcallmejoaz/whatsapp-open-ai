import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'ar';

const en = {
  appName: 'WhatsApp AI Inbox',
  signIn: 'Sign in',
  email: 'Email',
  password: 'Password',
  signOut: 'Sign out',
  inbox: 'Inbox',
  approvals: 'Approvals',
  search: 'Search',
  reports: 'Reports',
  settings: 'Connect ChatGPT',
  audit: 'Audit log',
  needsReply: 'Needs reply',
  urgent: 'Urgent',
  all: 'All',
  noConversations: 'Nothing here. Inbox zero 🎉',
  selectConversation: 'Select a conversation',
  windowOpen: 'Reply window open',
  windowClosed: '24h window closed — template only',
  windowLeft: '{h}h left to reply freely',
  summary: 'AI summary',
  summarize: 'Summarize',
  refresh: 'Refresh',
  openQuestions: 'Open questions',
  actionItems: 'Action items',
  mood: 'Customer mood',
  drafts: 'Reply',
  pendingApproval: 'Pending approval',
  approveSend: 'Approve & send',
  reject: 'Reject',
  retry: 'Retry',
  save: 'Save',
  edit: 'Edit',
  cancel: 'Cancel',
  generate: 'Draft with AI',
  instructionsPh: 'Optional guidance, e.g. “apologise and offer free delivery”',
  writeReply: 'Write a reply…',
  addDraft: 'Queue for approval',
  template: 'Template',
  chooseTemplate: 'Choose an approved template',
  param: 'Parameter {n}',
  voiceNote: 'Voice note',
  transcript: 'Transcript',
  fromPhone: 'sent from phone',
  history: 'synced history',
  imported: 'imported',
  viaMcp: 'via ChatGPT/MCP',
  aiDraft: 'AI draft',
  staffDraft: 'staff draft',
  failed: 'Failed',
  searchPh: 'Search all chats — English or Arabic, e.g. “late order” or “حجز طاولة”',
  noResults: 'No matches.',
  since: 'From',
  until: 'To',
  direction: 'Direction',
  any: 'Any',
  incoming: 'Customer',
  outgoing: 'Business',
  generateReport: 'Generate report',
  last24h: 'Last 24 hours',
  last7d: 'Last 7 days',
  language: 'Language',
  inboundMsgs: 'Inbound',
  outboundMsgs: 'Outbound',
  conversations: 'Conversations',
  waiting: 'Waiting for reply',
  medianResponse: 'Median first response',
  minutes: 'min',
  byIntent: 'By intent',
  bySentiment: 'Sentiment',
  noReports: 'No reports yet.',
  mcpTitle: 'Use this inbox from ChatGPT or Claude',
  mcpIntro:
    'The MCP endpoint lets ChatGPT search and summarize your chats and prepare replies. Messages it prepares land in Approvals; nothing is sent until a person approves it.',
  tokenName: 'Token name',
  createToken: 'Create token',
  scopeRead: 'read (search, summaries, reports)',
  scopeDraft: 'draft (prepare replies for approval)',
  tokenOnce: 'Copy this now; it is shown once.',
  revoke: 'Revoke',
  lastUsed: 'last used',
  never: 'never',
  copy: 'Copy',
  copied: 'Copied',
  mockMode: 'Demo mode: messages go to a local outbox, not WhatsApp',
  mockAi: 'Offline AI stub',
  noPending: 'No drafts waiting for approval.',
  open: 'Open',
  sent: 'Sent',
  rejected: 'Rejected',
  reason: 'Reason',
  error: 'Something went wrong',
  priority: { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' },
  intent: {
    order: 'Order', complaint: 'Complaint', question: 'Question', booking: 'Booking', payment: 'Payment',
    support: 'Support', feedback: 'Feedback', greeting: 'Greeting', spam: 'Spam', other: 'Other',
  },
  sentiment: { positive: 'Positive', neutral: 'Neutral', negative: 'Negative', mixed: 'Mixed' },
};

type Dict = typeof en;

const ar: Dict = {
  appName: 'صندوق واتساب الذكي',
  signIn: 'تسجيل الدخول',
  email: 'البريد الإلكتروني',
  password: 'كلمة المرور',
  signOut: 'تسجيل الخروج',
  inbox: 'الوارد',
  approvals: 'الموافقات',
  search: 'البحث',
  reports: 'التقارير',
  settings: 'ربط ChatGPT',
  audit: 'سجل التدقيق',
  needsReply: 'بانتظار الرد',
  urgent: 'عاجل',
  all: 'الكل',
  noConversations: 'لا يوجد شيء هنا 🎉',
  selectConversation: 'اختر محادثة',
  windowOpen: 'نافذة الرد مفتوحة',
  windowClosed: 'انتهت نافذة الـ٢٤ ساعة — القوالب فقط',
  windowLeft: 'متبقٍ {h} ساعة للرد الحر',
  summary: 'ملخص الذكاء الاصطناعي',
  summarize: 'تلخيص',
  refresh: 'تحديث',
  openQuestions: 'أسئلة مفتوحة',
  actionItems: 'مهام للمتابعة',
  mood: 'مزاج العميل',
  drafts: 'الرد',
  pendingApproval: 'بانتظار الموافقة',
  approveSend: 'موافقة وإرسال',
  reject: 'رفض',
  retry: 'إعادة المحاولة',
  save: 'حفظ',
  edit: 'تعديل',
  cancel: 'إلغاء',
  generate: 'صياغة رد بالذكاء الاصطناعي',
  instructionsPh: 'توجيه اختياري، مثل «اعتذر واعرض توصيلاً مجانياً»',
  writeReply: 'اكتب رداً…',
  addDraft: 'إرسال للموافقة',
  template: 'قالب',
  chooseTemplate: 'اختر قالباً معتمداً',
  param: 'المتغير {n}',
  voiceNote: 'رسالة صوتية',
  transcript: 'النص',
  fromPhone: 'أُرسلت من الهاتف',
  history: 'سجل متزامن',
  imported: 'مستورد',
  viaMcp: 'عبر ChatGPT/MCP',
  aiDraft: 'مسودة ذكاء اصطناعي',
  staffDraft: 'مسودة موظف',
  failed: 'فشل',
  searchPh: 'ابحث في كل المحادثات — بالعربية أو الإنجليزية، مثل «حجز طاولة» أو “late order”',
  noResults: 'لا توجد نتائج.',
  since: 'من',
  until: 'إلى',
  direction: 'الاتجاه',
  any: 'الكل',
  incoming: 'العميل',
  outgoing: 'النشاط التجاري',
  generateReport: 'إنشاء تقرير',
  last24h: 'آخر ٢٤ ساعة',
  last7d: 'آخر ٧ أيام',
  language: 'اللغة',
  inboundMsgs: 'واردة',
  outboundMsgs: 'صادرة',
  conversations: 'محادثات',
  waiting: 'بانتظار الرد',
  medianResponse: 'وسيط زمن الرد الأول',
  minutes: 'دقيقة',
  byIntent: 'حسب النية',
  bySentiment: 'المشاعر',
  noReports: 'لا توجد تقارير بعد.',
  mcpTitle: 'استخدم هذا الصندوق من ChatGPT أو Claude',
  mcpIntro:
    'تتيح نقطة MCP لـ ChatGPT البحث في محادثاتك وتلخيصها وتجهيز الردود. الرسائل التي يجهّزها تذهب إلى الموافقات، ولا يُرسل شيء قبل موافقة شخص.',
  tokenName: 'اسم الرمز',
  createToken: 'إنشاء رمز',
  scopeRead: 'قراءة (بحث، ملخصات، تقارير)',
  scopeDraft: 'مسودات (تجهيز ردود للموافقة)',
  tokenOnce: 'انسخه الآن؛ يظهر مرة واحدة فقط.',
  revoke: 'إلغاء',
  lastUsed: 'آخر استخدام',
  never: 'أبداً',
  copy: 'نسخ',
  copied: 'تم النسخ',
  mockMode: 'وضع العرض: الرسائل تُحفظ محلياً ولا تُرسل إلى واتساب',
  mockAi: 'ذكاء اصطناعي تجريبي دون اتصال',
  noPending: 'لا توجد مسودات بانتظار الموافقة.',
  open: 'فتح',
  sent: 'أُرسلت',
  rejected: 'مرفوضة',
  reason: 'السبب',
  error: 'حدث خطأ',
  priority: { urgent: 'عاجل', high: 'مرتفع', normal: 'عادي', low: 'منخفض' },
  intent: {
    order: 'طلب', complaint: 'شكوى', question: 'سؤال', booking: 'حجز', payment: 'دفع',
    support: 'دعم', feedback: 'ملاحظات', greeting: 'تحية', spam: 'مزعج', other: 'أخرى',
  },
  sentiment: { positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', mixed: 'مختلط' },
};

const DICTS: Record<Lang, Dict> = { en, ar };

interface I18n {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
  fmt: (s: string, vars: Record<string, string | number>) => string;
  time: (iso: string | null) => string;
  relative: (iso: string | null) => string;
}

const Ctx = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    // storage unavailable
  }
  return navigator.language.startsWith('ar') ? 'ar' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const value = useMemo<I18n>(() => {
    const locale = lang === 'ar' ? 'ar-AE' : 'en-GB';
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    const dtf = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    return {
      lang,
      t: DICTS[lang],
      setLang: (l) => {
        setLangState(l);
        try {
          localStorage.setItem('lang', l);
        } catch {
          // storage unavailable
        }
      },
      fmt: (s, vars) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')),
      time: (iso) => (iso ? dtf.format(new Date(iso)) : ''),
      relative: (iso) => {
        if (!iso) return '';
        const diff = (new Date(iso).getTime() - Date.now()) / 1000;
        const abs = Math.abs(diff);
        if (abs < 60) return rtf.format(Math.round(diff), 'second');
        if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
        return rtf.format(Math.round(diff / 86400), 'day');
      },
    };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside provider');
  return v;
}
