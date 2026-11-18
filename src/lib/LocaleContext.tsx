import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type LanguageCode,
  type CountryInfo,
  COUNTRIES,
  getCountry,
  getLanguage,
  bdtToLocal,
  localToBdt,
} from '@/data/countries';
import { translate, TRANSLATIONS } from '@/lib/i18n';

// Reverse map: English value → key, so useLanguage().t(bn, en) can look up
// the correct i18n key from the English string passed at call sites.
const EN_REVERSE: Record<string, string> = (() => {
  const enDict = TRANSLATIONS.EN;
  const map: Record<string, string> = {};
  for (const key of Object.keys(enDict)) {
    map[enDict[key].toLowerCase()] = key;
  }
  return map;
})();

function reverseLookup(englishText: string): string | undefined {
  return EN_REVERSE[englishText.toLowerCase()];
}

const STORAGE_KEY = 'et_locale';

interface StoredLocale {
  country: string;
  language: LanguageCode;
}

interface LocaleContextValue {
  language: LanguageCode;
  setLanguage: (lang: LanguageCode) => void;
  setCountryOnly: (code: string) => void;
  country: CountryInfo;
  setCountry: (code: string) => void;
  countryList: CountryInfo[];
  t: (key: string, fallback?: string) => string;
  isRtl: boolean;
  syncFromProfile: (preferredCountry?: string | null, preferredLanguage?: string | null) => void;
  // Currency conversion helpers
  bdtToDisplay: (bdtAmount: number) => number;
  displayToBdt: (displayAmount: number) => number;
  formatMoney: (bdtAmount: number) => string;
  formatMoneyPlain: (bdtAmount: number) => string;
  currencySymbol: string;
  currencyCode: string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const DEFAULT_COUNTRY = COUNTRIES[0]; // Bangladesh
const DEFAULT_LANGUAGE: LanguageCode = 'BN';

function loadStored(): StoredLocale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLocale;
    if (parsed && typeof parsed === 'object' && parsed.country && parsed.language) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveStored(locale: StoredLocale) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(locale));
  } catch {
    /* ignore */
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [countryCode, setCountryCode] = useState<string>(() => {
    const stored = loadStored();
    return stored?.country ?? DEFAULT_COUNTRY.code;
  });
  const [language, setLanguage] = useState<LanguageCode>(() => {
    const stored = loadStored();
    return stored?.language ?? DEFAULT_LANGUAGE;
  });

  const country = useMemo(() => {
    return getCountry(countryCode) ?? DEFAULT_COUNTRY;
  }, [countryCode]);

  // Sync language to country's primary language when country changes
  const setCountry = (code: string) => {
    const c = getCountry(code);
    if (!c) return;
    setCountryCode(code);
    // Auto-switch language to the country's primary language
    setLanguage(c.primaryLanguage);
  };

  // Persist locale whenever it changes
  useEffect(() => {
    saveStored({ country: countryCode, language });
  }, [countryCode, language]);

  // Apply RTL direction on the document
  const isRtl = getLanguage(language).rtl ?? false;
  useEffect(() => {
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  }, [isRtl]);

  // Set country without auto-switching language (used when syncing from profile)
  const setCountryOnly = (code: string) => {
    const c = getCountry(code);
    if (!c) return;
    setCountryCode(code);
  };

  // Sync locale from saved profile preferences (called after login)
  const syncFromProfile = (preferredCountry?: string | null, preferredLanguage?: string | null) => {
    if (preferredCountry && getCountry(preferredCountry)) {
      setCountryCode(preferredCountry);
    }
    if (preferredLanguage && getLanguage(preferredLanguage as LanguageCode)) {
      setLanguage(preferredLanguage as LanguageCode);
    }
  };

  const value = useMemo<LocaleContextValue>(() => ({
    language,
    setLanguage,
    setCountryOnly,
    country,
    setCountry,
    countryList: COUNTRIES,
    t: (key: string, fallback?: string) => translate(language, key, fallback),
    isRtl,
    syncFromProfile,
    bdtToDisplay: (bdt: number) => bdtToLocal(bdt, country),
    displayToBdt: (disp: number) => localToBdt(disp, country),
    formatMoney: (bdt: number) => formatCurrency(bdtToLocal(bdt, country), country.currencySymbol),
    formatMoneyPlain: (bdt: number) => formatCurrencyPlain(bdtToLocal(bdt, country), country.currencySymbol),
    currencySymbol: country.currencySymbol,
    currencyCode: country.currencyCode,
  }), [language, country, isRtl]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside LocaleProvider');
  return ctx;
}

// Backward-compatible hook so existing components calling useLanguage() still work.
// Existing call sites pass (bangla, english) pairs. For BN we return the bangla
// string; for any other language we try the i18n dictionary keyed by the english
// string, falling back to the english string itself.
export function useLanguage() {
  const ctx = useLocale();
  return {
    language: ctx.language,
    setLanguage: ctx.setLanguage,
    toggleLanguage: () => ctx.setLanguage(ctx.language === 'EN' ? 'BN' : 'EN'),
    t: (bn: string, en: string) => {
      if (ctx.language === 'BN') return bn;
      if (ctx.language === 'EN') return en;
      // For other languages, reverse-lookup the i18n key from the English
      // string, then translate into the target language.
      const key = reverseLookup(en);
      if (key) {
        const translated = translate(ctx.language, key, en);
        if (translated && translated !== en) return translated;
      }
      return en;
    },
  };
}

function formatCurrency(amount: number, symbol: string): string {
  const formatted = formatCurrencyPlain(amount, symbol);
  return `${symbol} ${formatted}`;
}

function formatCurrencyPlain(amount: number, _symbol: string): string {
  // For very large numbers (IDR, NGN, etc.), show no decimals
  const abs = Math.abs(amount);
  let decimals = 2;
  if (abs >= 1000) decimals = 0;
  else if (abs === 0) decimals = 0;

  let str = amount.toFixed(decimals);
  // Add thousands separators
  const parts = str.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  str = parts.join('.');
  // Remove trailing .00
  if (str.endsWith('.00')) str = str.slice(0, -3);
  return str || '0';
}
