package orders

// Total returns the order total in cents. The fixture deliberately omits quantity.
func Total(unit, quantity, discount int) int {
	return unit - discount
}
