import { describe, expect, it } from 'vitest';
import { detectScript, isRtl, normalizeArabic } from './arabic.ts';

describe('normalizeArabic', () => {
  it('strips tashkeel and tatweel', () => {
    expect(normalizeArabic('اسْتِلامُ الطَّلَبِ')).toBe('استلام الطلب');
    expect(normalizeArabic('مـــرحبـــا')).toBe('مرحبا');
  });

  it('unifies alef, yaa, taa marbuta and hamza carriers', () => {
    expect(normalizeArabic('إستلام')).toBe(normalizeArabic('استلام'));
    expect(normalizeArabic('آمنة')).toBe('امنه');
    expect(normalizeArabic('مستشفى')).toBe('مستشفي');
    expect(normalizeArabic('مسؤول')).toBe('مسوول');
    expect(normalizeArabic('فاتورة')).toBe(normalizeArabic('فاتوره'));
  });

  it('converts Arabic-Indic and Persian digits', () => {
    expect(normalizeArabic('طلب رقم ١٢٣٤')).toBe('طلب رقم 1234');
    expect(normalizeArabic('۴۵')).toBe('45');
  });

  it('maps Arabic punctuation and lowercases Latin', () => {
    expect(normalizeArabic('وين الطلب؟ Order ID، ABC')).toBe('وين الطلب? order id, abc');
  });
});

describe('detectScript', () => {
  it('detects Arabic, English, mixed and Arabizi', () => {
    expect(detectScript('وين طلبي؟ صار له اسبوع')).toBe('ar');
    expect(detectScript('Where is my order?')).toBe('en');
    expect(detectScript('ana 3ayez a7gez table bokra')).toBe('arabizi');
    expect(detectScript('طلبي رقم 55 ما وصل order late')).toBe('mixed');
    expect(detectScript('👍 123')).toBe('unknown');
    expect(detectScript('Table for 8 at 8pm on the 2nd please')).toBe('en');
  });

  it('decides RTL rendering', () => {
    expect(isRtl('مرحبا')).toBe(true);
    expect(isRtl('hello')).toBe(false);
  });
});
