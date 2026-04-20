package handler

import "github.com/acme/go-fixture/internal/store"

type UserHandler struct {
	store *store.UserStore
}

func NewUserHandler() *UserHandler {
	return &UserHandler{store: store.New()}
}

func (h *UserHandler) List() []string {
	return h.store.All()
}
