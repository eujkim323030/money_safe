import { useState } from 'react';
import { CATEGORY_ICONS, MAX_CATEGORIES, categoryArt } from '../shared/categories';
import type { Category } from '../shared/types';

export default function CategoryEditor({ categories, onChange }: { categories: Category[]; onChange: (categories: Category[]) => void }) {
  const [editingIcon, setEditingIcon] = useState<string | null>(null);
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
        {editingIcon === category.id && <fieldset className="category-art-picker"><legend>{category.name} 아이콘</legend>{CATEGORY_ICONS.map(icon => <button type="button" key={icon.id} aria-label={icon.name} aria-pressed={art.id === icon.id} onClick={() => { edit(category.id, { icon: icon.id }); setEditingIcon(null); }}><span className="category-art" style={{ backgroundColor: icon.color }}>{icon.symbol}</span><small>{icon.name}</small></button>)}</fieldset>}
      </div>;
    })}
    <button type="button" className="button wide" disabled={categories.length >= MAX_CATEGORIES} onClick={add}>＋ 카테고리 추가 ({categories.length}/{MAX_CATEGORIES})</button>
    <p className="fine-print">변경 후 아래 저장 버튼을 눌러 주세요. 이름을 바꿔도 기존 지출 기록은 연결된 채로 유지돼요.</p>
  </div>;
}
