package main

import (
	"fmt"

	"github.com/acme/go-fixture/internal/handler"
)

func main() {
	h := handler.NewUserHandler()
	fmt.Println(h.List())
}
