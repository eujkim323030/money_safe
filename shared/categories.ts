import type { Category } from './types';

export const MAX_CATEGORIES = 24;
export const CATEGORY_ICONS = [
  { id: 'food', symbol: '🍜', name: '식사', color: '#fff0da' },
  { id: 'cafe', symbol: '☕', name: '카페', color: '#f7e9de' },
  { id: 'date', symbol: '💗', name: '데이트', color: '#ffe7ef' },
  { id: 'shopping', symbol: '🛍️', name: '쇼핑', color: '#eee8ff' },
  { id: 'running', symbol: '👟', name: '운동', color: '#e4f6ee' },
  { id: 'transport', symbol: '🚇', name: '교통', color: '#e4f1ff' },
  { id: 'health', symbol: '💊', name: '병원·건강', color: '#ffe7ef' },
  { id: 'subscription', symbol: '📱', name: '구독·통신', color: '#eee8ff' },
  { id: 'home', symbol: '🏠', name: '주거', color: '#fff0da' },
  { id: 'pet', symbol: '🐾', name: '반려동물', color: '#f7e9de' },
  { id: 'learning', symbol: '📚', name: '교육·책', color: '#e4f1ff' },
  { id: 'gift', symbol: '🎁', name: '선물', color: '#ffe7ef' },
  { id: 'travel', symbol: '✈️', name: '여행', color: '#e4f6ee' },
  { id: 'beauty', symbol: '💄', name: '미용', color: '#ffe7ef' },
  { id: 'culture', symbol: '🎬', name: '문화', color: '#eee8ff' },
  { id: 'other', symbol: '✦', name: '기타', color: '#e4f1ff' },
] as const;

export function categoryArt(category?: Pick<Category, 'id' | 'icon'>) {
  return CATEGORY_ICONS.find(item => item.id === (category?.icon ?? category?.id)) ?? CATEGORY_ICONS[CATEGORY_ICONS.length - 1];
}
