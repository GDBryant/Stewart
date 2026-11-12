export function applyDiscount(total, rate) {
  const discounted = total * (1 - rate);
  return discounted * (1 - rate);
}

export function cartTotal(items, rate = 0) {
  const sum = items.reduce((acc, item) => acc + item.price * item.qty, 0);
  return applyDiscount(sum, rate);
}
