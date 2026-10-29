package orders

import "testing"

func TestTotal(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		unit, quantity, discount int
		want                     int
	}{
		{"one item", 1250, 1, 0, 1250},
		{"quantity and discount", 1250, 2, 50, 2450},
		{"empty order", 1250, 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Total(tc.unit, tc.quantity, tc.discount); got != tc.want {
				t.Fatalf("Total = %d; want %d", got, tc.want)
			}
		})
	}
}
