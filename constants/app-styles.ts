import { StyleSheet } from 'react-native'

export const appStyles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d1d1',
    borderRadius: 2,
    borderWidth: 1,
    elevation: 1,
    padding: 4,
  },
  cardVerified: {
    backgroundColor: '#f2fbf4',
    borderColor: '#2e7d32',
    borderRadius: 2,
    borderWidth: 1,
    elevation: 1,
    padding: 4,
  },
  errorText: {
    color: '#b3261e',
  },
  hintText: {
    color: '#5f6368',
  },
  linkText: {
    color: '#1a73e8',
    textDecorationLine: 'underline',
  },
  tierLabel: {
    fontWeight: 'bold',
  },
  screen: {
    flex: 1,
    gap: 16,
    paddingHorizontal: 8,
  },
  stack: {
    gap: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
})
