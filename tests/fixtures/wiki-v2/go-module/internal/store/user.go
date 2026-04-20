package store

type UserStore struct {
	users []string
}

func New() *UserStore {
	return &UserStore{users: []string{"alice", "bob"}}
}

func (s *UserStore) All() []string {
	return s.users
}
