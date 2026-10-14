import { isRegular } from '../shared/regular-expenses';
import { useState } from 'react';
import { CATEGORY_ICONS, MAX_CATEGORIES, categoryArt } from '../shared/categories';
import type { Category, Expense } from '../shared/types';

export default function CategoryEditor({ categories, expenses, onChange, onDelete }: { categories: Category[]; expenses: Expense[]; onChange: (categories: Category[]) => void; onDelete: (from: string, to: string) => boolean }) {
  const [editingIcon, setEditingIcon] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [destination, setDestination] = useState('');
  function edit(id: string, patch: Partial<Category>) {
    onChange(categories.map(item => item.id === id ? { ...item, ...patch } : item));
  }
  function add() {
    if (categories.length >= MAX_CATEGORIES) return;
    const category = { id: `custom_${crypto.randomUUID()}`, name: '새 카테고리', budget: 0, icon: 'other' };
    onChange([...categories, category]); setEditingIcon(category.id);
  }
  return <div className="category-editor">
    <p className="inline-note">이름과 아이콘을 내 생활에 맞게 바꿔요. 새 항목은 0원으로 시작해요. 예산을 늘리면 다른 항목에서 같은 금액을 줄여 주세요.</p>
    {categories.map((category, index) => {
      const art = categoryArt(category);
      return <div className="category-edit-row" key={category.id}>
        <div className="category-edit-fields">
          <button type="button" className="category-icon category-art" style={{ backgroundColor: art.color }} aria-label={`${category.name} 아이콘 선택`} aria-expanded={editingIcon === category.id} onClick={() => setEditingIcon(editingIcon === category.id ? null : category.id)}>{art.symbol}</button>
          <label className="field">이름<input aria-label={`카테고리 ${index + 1} 이름`} required maxLength={30} value={category.name} onChange={event => edit(category.id, { name: event.target.value })} /></label>
          <label className="field">예산 (원)<input aria-label={`카테고리 ${index + 1} 예산`} type="number" inputMode="numeric" required min={0} step={1} value={category.budget} onChange={event => edit(category.id, { budget: Number(event.target.value) })} /></label>
        </div>
        <div className="category-kind" role="group" aria-label={`${category.name} 지출 구분`}>
          <button type="button" aria-pressed={!isRegular(category)} onClick={() => edit(category.id, { kind: 'variable' })}>비정기</button>
          <button type="button" aria-pressed={isRegular(category)} onClick={() => edit(category.id, { kind: 'regular' })}>정기</button>
        </div>
        {editingIcon === category.id && <fieldset className="category-art-picker"><legend>{category.name} 아이콘</legend>{CATEGORY_ICONS.map(icon => <button type="button" key={icon.id} aria-label={icon.name} aria-pressed={art.id === icon.id} onClick={() => { edit(category.id, { icon: icon.id }); setEditingIcon(null); }}><span className="category-art" style={{ backgroundColor: icon.color }}>{icon.symbol}</span><small>{icon.name}</small></button>)}</fieldset>}
        <button type="button" className="text-button danger category-delete-button" disabled={categories.length < 2} aria-label={`${category.name} 카테고리 삭제`} onClick={() => { setDeleting(category.id); setDestination(''); }}>{categories.length < 2 ? '마지막 카테고리는 유지해요' : '카테고리 삭제'}</button>
        {deleting === category.id && <div className="category-delete-panel" role="group" aria-label={`${category.name} 삭제 확인`}>
          <p>‘{category.name}’의 지출 {expenses.filter(expense => expense.category === category.id).length}건과 예산 {category.budget.toLocaleString('ko-KR')}원을 아래 카테고리로 옮겨요. 기록과 전체 예산은 유지돼요.</p>
          <label className="field">옮길 카테고리<select value={destination} onChange={event => setDestination(event.target.value)}><option value="">선택해 주세요</option>{categories.filter(item => item.id !== category.id).map(item => <option key={item.id} value={item.id}>{categoryArt(item).symbol} {item.name}</option>)}</select></label>
          <div className="button-row"><button type="button" className="button" onClick={() => setDeleting(null)}>취소</button><button type="button" className="button danger-button" disabled={!destination} onClick={() => { if (onDelete(category.id, destination)) { setDeleting(null); setEditingIcon(null); } }}>옮기고 삭제</button></div>
          <p className="fine-print">아래 ‘예산 · 목표 · 알림 시간 저장하기’를 눌러야 반영돼요.</p>
        </div>}
      </div>;
    })}
    <button type="button" className="button wide" disabled={categories.length >= MAX_CATEGORIES} onClick={add}>＋ 카테고리 추가 ({categories.length}/{MAX_CATEGORIES})</button>
    <p className="fine-print">정기는 매달 예상하는 지출이며 금액이 꼭 같을 필요는 없어요. 구분을 바꾸면 기존 기록도 새 구분으로 집계돼요. 변경 후 아래 저장 버튼을 눌러 주세요. 이름을 바꿔도 기존 지출 기록은 연결된 채로 유지돼요.</p>
  </div>;
}
